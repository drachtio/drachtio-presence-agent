const debug = require('debug')('drachtio:presence-agent');
const assert = require('assert');
const {parseAor, parseEventHeader, getDefaultSubscriptionExpiry} = require('./utils');
const _ = require('lodash');
const supportedEvents = process.env.SUPPORTED_EVENTS.split(',').map((e) => e.trim());

/**
 * @module subscribe
 * @see https://tools.ietf.org/html/rfc3265
 *
 * This module exposes an State Agent per RFC 3265.
 */

const dialogs = new Map();

module.exports = function(logger) {

  return (req, res) => {
    if (validate(logger, req, res)) {
      initial(logger, req, res);
    }
  };
};

const initial = async(logger, req, res) => {
  const {redisDb} = req.srf.locals;
  logger.info(req.event, 'subscribe#initial');
  debug(req.event, 'subscribe#initial');

  try {
    const uas = await req.srf.createUAS(req, res, {headers: {'Expires': req.expiry}});
    const sub = await redisDb.addSubscription(uas, req.event, req.expiry);
    uas
      .on('unsubscribe', (req, res) => remove(logger, redisDb, req, res, uas, sub))
      .on('subscribe', (req, res) => refresh(logger, redisDb, req, res, uas, sub));

    startSubscriptionTimer(logger, redisDb, uas, sub, req.expiry);
    notify(logger, redisDb, req.event, uas, 'active');
  } catch (err) {
    logger.error(err, `subscribe#initial: Error: ${err}`);
    res.send(480);
  }
};

const refresh = async(logger, db, req, res, dlg, subscription) => {
  const event = req.get('Event');
  const expiry = (req.has('Expires') ?
    parseInt(req.get('Expires')) :
    getDefaultSubscriptionExpiry(event)) || 3600;

  logger.info(req.event, `subscribe#refresh with expiry ${expiry}`);
  debug(`subscribe#refresh with expiry ${expiry}`);

  try {
    clearSubscriptionTimer(logger, db, dlg, subscription, true);
    await db.removeSubscription(subscription);
    subscription = await db.addSubscription(dlg, req.event, req.expiry);
    startSubscriptionTimer(dlg, db, dlg, subscription, expiry);
    res.send(202, {headers: {'Expires': expiry}});
    await notify(logger, db, subscription, dlg, 'active');
  } catch (err) {
    logger.error(err, 'subscribe#refresh');
    res.send(480);
  }
};

const remove = async(logger, db, req, res, dlg, subscription) => {
  logger.info(subscription, 'subscribe#remove');
  await notify(logger, db, subscription, dlg, 'terminated');
  await db.removeSubscription(subscription);
  clearSubscriptionTimer(dlg, db, subscription, true);
};

const notify = async(logger, db, sub, dlg, subscriptionState) => {
  const state = await db.getEventState(sub.subscriber, sub.resource, sub.eventType);
  debug(`subscribe#notify: got event state for ${sub.resource}:${sub.eventType} ${JSON.stringify(state)}`);
  let body;
  const headers = {
    'Call-ID': sub.callId,
    'Subscription-State': subscriptionState,
    'Event': sub.eventType
  };

  if (state && subscriptionState !== 'terminated') {
    Object.assign(headers, {'Content-Type': state.contentType});
    body = state.content;
  }
  dlg.request({
    method: 'NOTIFY',
    body,
    headers
  });
};


function validate(logger, req, res) {
  if (!req.has('Event')) {
    logger.info(`SUBSCRIBE request is missing Event header: ${req.get('Call-ID')}`);
    res.send(400);
    return false;
  }
  const to = req.getParsedHeader('to');
  const from = req.getParsedHeader('from');
  const {event, id} = parseEventHeader(req.get('Event'));
  if (!supportedEvents.includes(event)) {
    logger.info(`SUBSCRIBE request for unsupported event ${req.get('Event')}: ${req.get('Call-ID')}`);
    res.send(489);
    return false;
  }

  req.event = {
    subscriber: parseAor(from.uri),
    resource: parseAor(to.uri),
    eventType: event,
    id: id,
    accept: req.get('Accept'),
    callId: req.get('Call-ID')
  };

  // remove any undefined values
  req.event = _.omitBy(req.event, _.isNil);

  req.expiry = req.has('Expires') ? parseInt(req.get('Expires')) : getDefaultSubscriptionExpiry(event);
  logger.info(`SUBSCRIBE: ${req.event.subscriber} -> ${req.event.resource}: ${req.expiry}`);

  if (0 === req.expiry) {
    logger.info('received SUBSCRIBE with Expires: 0 outside of a dialog');
    res.send(200); // unsubscribe should be within a dialog
    return false;
  }

  return true;
}

function startSubscriptionTimer(logger, db, dlg, subscription, expiry) {
  const timer = setTimeout(_expireSubscription.bind(null, logger, db, dlg, subscription), expiry * 1000);

  const subs = dialogs.get(dlg.id) || [];
  subs.push({subscription, timer});
  dialogs.set(dlg.id, subs);
}

function clearSubscriptionTimer(logger, db, dlg, subscription, andCancel) {
  const subs = dialogs.get(dlg.id);
  const arr = _.remove(subs, (s) => { return s.subscription.eventType === subscription.eventType; });
  assert(Array.isArray(arr) && arr.length === 1);

  if (andCancel) clearTimeout(arr[0].timer);
  if (0 === subs.length) dialogs.delete(dlg.id);

  debug(`subscribe#clearSubscriptionTimer: after clearing subscription there are ${dialogs.size} dialogs`);
}

function _expireSubscription(logger, db, dlg, subscription) {
  logger.info(subscription, `subscription timed out on dialog with Call-ID ${dlg.sip.callId}`);
  notify(logger, db, subscription, dlg, 'terminated');

  /* NOTE: no need to call db.removeSubscription(subscription)
   * because keys were set to expire on their own in redis
  */
  clearSubscriptionTimer(logger, dlg, subscription);
}
