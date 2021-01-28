const assert = require('assert');
const bluebird = require('bluebird');
const redis = require('redis');
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
const Emitter = require('events');
const debug = require('debug')('drachtio:presence-agent');
const {generateETag} = require('./utils');
const short = require('short-uuid');
const translator = short();
const ZSET = 'event_zset';

class RedisDb extends Emitter {
  /**
   * Creates an instance of the persistence layer backed by redis
   * @param  logger pino logger
   */
  constructor(logger, srf) {
    super();
    this.logger = logger;
    this._init(srf);
  }

  _init(srf) {
    const host = process.env.REDIS_HOST || '127.0.0.1';
    const port = process.env.REDIS_PORT || 6379;
    this.client = redis.createClient(port, host);
    this.client.on('connect', () => {
      this.logger.info(`successfully connected to redis at ${host}:${port}`);
      this.emit('connect');
    })
      .on('error', (err) => {
        this.logger.error(err, `Error connecting to redis at ${host}:${port}`) ;
      });

    this.eventPackages = require('./events')(this.logger, this.client, srf);
  }

  disconnect() {
    this.client.quit();
  }

  get lastInsert() {
    return this._lastInsert;
  }

  get lastRefresh() {
    return this._lastRefresh;
  }

  get lastModify() {
    return this._lastModify;
  }

  /**
   * Registrations data model:
   *
   * Active registrations are stored in a hash keyed by reg:${user}:${realm}
   * The hash consists of:
   *  - aor - a sip address-of-record for a user (e.g. daveh@drachtio.org)
   *  - contact - the sip address where this user can be reached
   *  - sbcAddress - the sip uri address of the drachtio server that manages the connection to this user
   *  - protocol - the transport protocol used between the drachtio server and the user
   *  - proxy - the source address and port of the registering device
   *  - expires - number of seconds the registration for this user is active
   */

  /**
   * Add a registration for a user identified by a sip address-of-record
   * @param {String} aor - a sip address-of-record for a user (e.g. daveh@drachtio.org)
   * @param {String} contact - the sip address where this user can be reached
   * @param {String} sbcAddress - the sip uri address of the sbc that manages the connection to this user
   * @param {String} protocol - the transport protocol used between the sbc and the user
   * @param {String} proxy - the source address and port of the registering device
   * @param {String} expires - number of seconds the registration for this user is active
   * @returns {Boolean} true if the registration was successfully added
   */
  async addRegistration(aor, obj, expires) {
    debug(`Registrar#add ${aor} from ${JSON.stringify(obj)} for ${expires}`);
    const key = makeRegKey(aor);
    try {
      const result = await this.client
        .multi()
        .hmset(key, obj)
        .expire(key, expires)
        .execAsync();
      debug(`Registrar#add - result of adding ${aor}: ${JSON.stringify(result)}`);
      return result[0] === 'OK';
    } catch (err) {
      this.logger.error(err, `Error adding user ${aor}`);
      return false;
    }
  }
  /**
   * Retrieve the registration details for a user
   * @param {String} aor - the address-of-record for the user
   * @returns {Object} an object containing the registration details for this user, or null
   * if the user does not have an active registration.
   */
  async queryRegistration(aor) {
    const key = makeRegKey(aor);
    const result = await this.client.hgetallAsync(key);
    debug(`Registrar#query: ${aor} returned ${JSON.stringify(result)}`);
    return result;
  }

  /**
   * Remove the registration for a user
  * @param {String} aor - the address-of-record for the user
  * @returns {Boolean} true if the registration was successfully removed
  */
  async removeRegistration(aor) {
    const key = makeRegKey(aor);
    debug(`Registrar#remove ${aor}`);
    try {
      const result = await this.client.delAsync(key);
      debug(`Registrar#remove ${aor} result: ${result}`);
      return result === 1;
    } catch (err) {
      this.logger.error(err, `Error removing aor ${aor}`);
      return false;
    }
  }

  async keys(prefix) {
    try {
      prefix = prefix || '*';
      const result = await this.client.keysAsync(prefix);
      debug(`keys ${prefix}: ${JSON.stringify(result)}`);
      return result;
    } catch (err) {
      this.logger.error(err, `Error keys ${prefix}`);
      debug(err, `Error keys prefix ${prefix}`);
      return null;
    }
  }

  // TODO: change to use SCAN for performance
  async getCountOfRegistrations() {
    try {
      const result = await this.client.keysAsync('reg:*');
      return result.length;
    } catch (err) {
      this.logger.error(err, 'Error retrieving registered users');
    }
  }

  /**
   *
   * State Agent Data model:
   * I. Event State
   * Event state is maintained in a redis hash that has both a key and a secondary index.
   * The hash consists of:
   *   - aor (address of record) of a resource
   *   - event type
   *   - entity tag
   *   - content type
   *   - content (/current state of the resource)
   * The hash is keyed by es:aor:${event type}; e.g es:resource@example.com:dialog
   *
   * The secondary index is the entity tag, so we can look up event state either by aor or by entity tag
   *
   * II. Subscriptions
   * Subscriptions are maintained in a redis hash consisting of:
   *   - subscriber aor (address of record of subscriber)
   *   - resource aor (address of record being subscribed to)
   *   - event type
   *   - id (if provided in the Event header of the SUBSCRIBE request)
   *   - SIP Call-ID of SUBSCRIBE dialog
   *   - Accept header (if provided in SUBSCRIBE)
   *  The hash is keyed by sub:${uuid} where uuid is randomly generated
   *
   * we need to retrieve subscriptions in the following ways:
   *   - by subscriber aor, resource aor, event type, and id
   *   - by subscriber aor, resource aor, event type, and call-id
   * to do this we have the following keys:
   *   subkeyid:${res-aor}:${event type}:${sub-aor}:${id}
   *   subkeydlg:${res-aor}:${event type}:${sub-aor}:${call-id}
   */

  async addEventState(aor, expiry, eventType, contentType, content) {
    const etag = generateETag();
    const key = makeEventStateKey(aor, eventType);
    const data = {
      aor,
      eventType,
      etag,
      contentType,
      content
    };

    const replies = await this.client.multi()
      .hmset(key, data)
      .expire(key, expiry)
      .zadd(ZSET, parseInt(etag), key)
      .execAsync();
    debug(`replies from adding state for key ${key}: ${replies}`);
    return data;
  }

  async getEventState(subscriber, aor, eventType) {
    // check for overrides / custom event package handling
    if (this.eventPackages[eventType]) {
      debug(`getEventState: custom event package behavior for ${eventType}`);
      assert.ok(typeof this.eventPackages[eventType].getEventState === 'function',
        `${eventType} package missing implementation of getEventState`);
      return await this.eventPackages[eventType].getEventState(subscriber, aor);
    }
    const key = makeEventStateKey(aor, eventType);
    const obj = await this.client.hgetallAsync(key);
    debug(`retrieved event state for aor ${aor} event ${eventType}: ${JSON.stringify(obj)}`);
    return obj;
  }

  async getEventStateByETag(etag) {
    const cmd = [ZSET, `${etag}`, `${etag}`];
    try {
      const obj = await this.client.zrangebyscoreAsync(cmd);
      if (Array.isArray(obj) && obj.length === 1) {
        const data = this.client.hgetallAsync(obj[0]);
        debug(`Db#getEventStateByETag: retrieved event state for etag ${etag}: ${JSON.stringify(data)}`);
        return data;
      }
    } catch (err) {
      this.logger.error({err}, 'Error retreiving event state by ETag');
    }
  }

  async refreshEventState(aor, eventType, expiry) {
    const etag = generateETag();
    const key = makeEventStateKey(aor, eventType);
    const replies = await this.client.multi()
      .hset(key, 'etag', etag)
      .expire(key, expiry)
      .zrem(ZSET, key)
      .zadd(ZSET, parseInt(etag), key)
      .execAsync();
    debug(`Db#refreshEventState: replies ${JSON.stringify(replies)}`);
    return etag;
  }

  async modifyEventState(data, expiry, contentType, content) {
    const key = makeEventStateKey(data.aor, data.eventType);
    const etag = data.etag = generateETag();
    data.content = content;
    debug(`Db#modifyEventState: refeshing event state for key ${key} with expiry ${expiry} and new etag: ${etag}`);
    debug(`Db#modifyEventState: new event state: ${JSON.stringify(data)}`);
    const replies = await this.client.multi()
      .hmset(key, data)
      .expire(key, expiry)
      .zrem(ZSET, key)
      .zadd(ZSET, parseInt(etag), key)
      .execAsync();
    debug(`Db#modifyEventState: replies ${JSON.stringify(replies)}`);
    return etag;
  }

  async removeEventState(etag) {
    const data = await this.getEventStateByETag(etag);
    if (!data) throw new Error(`db#removeEventState etag not found: ${etag}`);
    const key = makeEventStateKey(data.aor, data.eventType);
    const replies = await this.client.multi()
      .del(key)
      .zrem(ZSET, key)
      .execAsync();
    debug(`Db#removeEventState: replies ${JSON.stringify(replies)}`);
    return data.aor;
  }

  async purgeExpired() {
    let nExpired = 0 ;
    const cmd = [ZSET, '-inf', '+inf'];
    const arr = await this.client.zrangebyscoreAsync(cmd);
    debug(`Db#purgeExpired - checking ${arr.length} sorted set items`);

    for (const aor of arr) {
      try {
        const obj = await this.client.hgetallAsync(aor);
        if (!obj) {
          debug(`Db#purgeExpired - removing expired item ${aor}`);
          const reply = this.client.zremAsync([ZSET, aor]);
          nExpired++;
          debug(`Db#purgeExpired removed entry ${aor}: ${reply}`);
        }
      } catch (err) {
        this.logger.error(`Db#purgeExpired error checking existence of key ${aor}: ${err}`);
      }
    }
    return nExpired;
  }

  async getCountOfEtags() {
    try {
      const count = await this.client.zcountAsync([ZSET, '-inf', '+inf']);
      return count;
    } catch (err) {
      this.logger.error({err}, 'Error getCountOfEtags');
    }
  }

  async getCountOfKeys() {
    try {
      const keys = await this.client.keysAsync('*');
      return keys.length;
    } catch (err) {
      this.logger.error({err}, 'Error getCountOfKeys');
    }
  }

  async dump(type) {
    try {
      if (type === 'etag') {
        const cmd = [ZSET, '-inf', '+inf'];
        debug(`Db#getEventStateByETag: ${cmd}`);
        const obj = await this.client.zrangebyscoreAsync(cmd);
        this.logger.info(obj, 'db.dump etag');
        debug(`etags: ${JSON.stringify(obj)}`);
        return obj;
      }
    } catch (err) {
      this.logger.error({err}, 'Error dump');
    }
  }


  /** Subscriptions */

  async findSubscriptions(resource, event) {
    const key = makeSubStateKeyWildCard(resource, event);
    const dlgKeys = await this.client.keysAsync(key);
    debug(`Db#findSubscriptionsForEvent: retrieved subscription keys ${dlgKeys} for key: ${key}`);
    if (!dlgKeys) throw new Error('E_NO_SUBSCRIPTION');

    const subscribers = [];
    for (const dlgkey of dlgKeys) {
      debug(`Db#findSubscriptionsForEvent calling hgetall for key ${dlgkey}`);
      try {
        const key = await this.client.getAsync(dlgkey);
        const obj = await this.client.hgetallAsync(key);
        debug(`Db#findSubscriptionsForEvent event state for key ${key}: ${JSON.stringify(obj)}`);
        subscribers.push(obj);
      } catch (err) {
        this.logger.error({err}, `Error findSubscriptions dlgkey: ${dlgkey}`);
      }
    }
    return subscribers;
  }

  async addSubscription(dlg, obj, expiry) {
    debug(`db#addSubscription ${JSON.stringify(obj)}`);
    // check for event package override
    if (this.eventPackages[obj.eventType]) {
      debug(`addSubscription: custom event package behavior for ${obj.eventType}`);
      assert.ok(typeof this.eventPackages[obj.eventType].addSubscription === 'function',
        `${obj.eventType} package missing implementation of addSubscription`);
      obj.override = true;
      return await this.eventPackages[obj.eventType].addSubscription(dlg, obj, expiry);
    }

    const key = makeSubStateKey();
    const keyDialog = makeSubStateKeyDialog(obj.subscriber, obj.resource, obj.eventType, obj.callId);

    debug(`db#addSubscription ${key} and ${keyDialog} with expiry ${expiry} for ${JSON.stringify(obj)}`);
    const multi = this.client.multi()
      .hmset(key, obj)
      .set(keyDialog, key)
      .expire(key, expiry)
      .expire(keyDialog, expiry);
    if (obj.id) {
      const keyId = makeSubStateKeyId(obj.subscriber, obj.resource, obj.eventType, obj.id);
      multi
        .set(keyId, key)
        .expire(keyId, expiry);
    }
    const replies = await multi.execAsync();
    debug(`Db#addSubscription: replies ${JSON.stringify(replies)}`);
    return obj;
  }

  async removeSubscription(obj) {
    // check for event package override
    if (this.eventPackages[obj.eventType]) {
      debug(`removeSubscription: custom event package behavior for ${obj.eventType}`);
      assert.ok(typeof this.eventPackages[obj.eventType].removeSubscription === 'function',
        `${obj.eventType} package missing implementation of removeSubscription`);
      obj.override = true;
      return await this.eventPackages[obj.eventType].removeSubscription(obj);
    }

    const keyDialog = makeSubStateKeyDialog(obj.subscriber, obj.resource, obj.eventType, obj.callId);
    const value = await this.client.getAsync(keyDialog);
    debug(`db.removeSubscription: retrieved value ${value} for key ${keyDialog}`);
    const multi = this.client.multi()
      .del(keyDialog)
      .del(value);
    if (obj.id) {
      const keyId = makeSubStateKeyId(obj.subscriber, obj.resource, obj.eventType, obj.id);
      multi.del(keyId);
    }
    const replies = await multi.execAsync();
    debug(`Db#removeSubscription: replies ${JSON.stringify(replies)}`);
  }

  async getCountOfSubscriptions() {
    const keys = await this.client.keysAsync('sub:*');
    return keys.length;
  }

}

const makeRegKey = (aor) => {
  return `reg:${aor}`;
};

const makeEventStateKey = (aor, event) => {
  return `es:${aor}:${event}`;
};

const makeSubStateKey = () => {
  return `sub:${translator.new()}`;
};

const makeSubStateKeyId = (subscriber, resource, event, id) => {
  return `subkeyid:${resource}:${event}:${subscriber}:${id}`;
};

const makeSubStateKeyDialog = (subscriber, resource, event, callid) => {
  return `subkeydlg:${resource}:${event}:${subscriber}:${callid}`;
};

const makeSubStateKeyWildCard = (resource, event) => {
  return `subkeydlg:${resource}:${event}:*`;
};


module.exports = RedisDb;


