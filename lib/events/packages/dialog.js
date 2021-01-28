const bluebird = require('bluebird');
const redis = require('redis');
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
const short = require('short-uuid');
const translator = short();
const {generateETag} = require('../../utils');
const MAX_CALL_LENGTH = 60 * 60 * 3; //3 hrs

/**
 * Data model:
 *
 * The dialog event package is described at https://tools.ietf.org/html/rfc4235
 *
 * Basically, interested observers (typically a sip device) can "subscribe" to dialog events
 * from other sip endpoints.  In the code below, we use the term "aor" (address of record) to
 * identify a sip endpoint that can be subscribed to.  The format of an aor is "user@domain".
 * There are several data structures that are used to track subscriptions and dialogs,
 * and these are maintained in a redis database.
 *
 *
 * 1. Dialog info.
 * For each active call we maintain a key that has an associated hash of data
 * for the call: dialog id, call state, direction, call-id, local and remote tag.
 *
 * 2. Subscribed aors
 * We maintain a key for each aor that has at least one active subscription.
 * The value is an array of subscriptions, where each element in the list
 * provides a key to the structure below.
 *
 * 3. Active subscription
 * We maintain a key for each active subscription (subscriber-to-subscribed-aor pair).
 * The value is a hash of data that is needed to send a NOTIFY to the subscriber.
 *
 */

const makeDialogInfoKey = (aor) => `dlg-info:$${aor}`;
const makeSubscriptionName = (subscriber, resource) => `dlg-sub:${subscriber}-${resource}`;
const makeSubscribedResourceKey = (resource) => `watched-aor:${resource}`;

const dialogGetEventState = async(logger, client, pubsub, subscriber, resource) => {

  const key = makeDialogInfoKey(resource);
  const subKey = makeSubscriptionName(subscriber, resource);
  try {
    const dialogInfo = await client.hgetallAsync(key);
    const subscriptionData = await client.hgetallAsync(subKey);
    if (!subscriptionData) {
      logger.info(`dialog#dialogGetEventState: Error subscription not found: ${subKey}`);
    }
    else {
      const content = makeXmlContent(subscriptionData, dialogInfo);
      logger.info({content, subscriptionData}, `dialog#dialogGetEventState: subscription data for ${subKey}`);

      return {
        aor: resource,
        etag: subscriptionData.etag,
        eventType: 'dialog',
        contentType: 'application/dialog-info+xml',
        content
      };
    }
  } catch (err) {
    logger.error({err}, `dialog#dialogGetEventState: Error retrieving event state of: ${resource} for ${subscriber}`);
  }
};

const dialogAddSubscription = async(logger, client, pubsub, dlg, obj, expiry) => {
  const {subscriber, resource} = obj;

  const subscriptionName = makeSubscriptionName(subscriber, resource);
  const key = makeSubscribedResourceKey(resource);
  try {
    // if we were not previously watching this aor, we are now
    client.saddAsync(key, subscriptionName)
      .catch((err) => logger.error({err}, `Error adding ${subscriptionName} to set ${key}`));

    // save the subscription data
    const subscriptionData = {
      aor: resource,
      dialogId: `${dlg.sip.callId};from-tag=${dlg.sip.remoteTag}`,
      count: 0,
      etag: generateETag(),
      id: translator.new(),
      notifyType: 'sip'
    };
    logger.info({subscriptionData}, `dialogAddSubscription: adding dialoginfo for ${subscriptionName}`);
    const response = await client.multi()
      .hmset(subscriptionName, subscriptionData)
      .expire(subscriptionName, expiry)
      .execAsync();
    logger.info({response}, `dialogAddSubscription: added dialoginfo for ${subscriptionName}`);
    return subscriptionData;
  } catch (err) {
    logger.error({err}, `dialogAddSubscription: error adding dialoginfo for ${subscriptionName}`);
  }
};

const dialogRemoveSubscription = async(logger, client, pubsub, obj) => {
  const {subscriber, resource} = obj;
  const subscriptionName = makeSubscriptionName(subscriber, resource);
  const key = makeSubscribedResourceKey(resource);
  try {
    let response = await client.sremAsync(key, subscriptionName);
    logger.info({response}, `dialogRemoveSubscription: removed ${subscriptionName} from set ${key}`);

    response = await client.delAsync(subscriptionName);
    logger.info({response}, `dialogRemoveSubscription: removed dialoginfo for ${subscriptionName}`);
  } catch (err) {
    logger.error({err}, `dialogRemoveSubscription: error removing dialoginfo for ${subscriptionName}`);
  }
};

module.exports = function(logger, client, srf) {
  const pubsub = client.duplicate();
  pubsub.on('connect', () => {
    pubsub.on('subscribe', (channel, count) => {
      logger.info(`successfully subscribed to channel ${channel}, count is ${count}`);
    });
    pubsub.on('message', onMessage.bind(null, logger, srf, client));
    pubsub.subscribe('dialog');
  })
    .on('error', (err) => {
      logger.error(err, 'Error connecting to redis for pubsub') ;
    });

  return {
    getEventState: dialogGetEventState.bind(null, logger, client, pubsub),
    addSubscription: dialogAddSubscription.bind(null, logger, client, pubsub),
    removeSubscription: dialogRemoveSubscription.bind(null, logger, client, pubsub)
  };
};

const onMessage = async(logger, srf, client, channel, msg) => {
  const [aor, id, callId, lTag, rTag, direction, state] = msg.split(' ');
  logger.info(`got dialog event: ${aor} ${callId} ${lTag} ${rTag} ${direction} ${state}`);

  const localTag = 'undef' === lTag ? undefined : lTag;
  const remoteTag = 'undef' === rTag ? undefined : rTag;

  /* add / update dialog info */
  const key = makeDialogInfoKey(aor);
  if (['terminated', 'rejected', 'cancelled'].includes(state)) {
    client.delAsync(key)
      .catch((err) => logger.info({err}, `dialog#onMessage: Error deleting ${key}`));
  }
  else {
    const dialogInfo = {
      id,
      direction,
      state,
      callId
    };
    if (localTag) dialogInfo.localTag = localTag;
    if (remoteTag) dialogInfo.remoteTag = remoteTag;
    client.multi()
      .hmset(key, dialogInfo)
      .expire(key, MAX_CALL_LENGTH)
      .execAsync()
      .then((response) => {
        return logger.info({response, dialogInfo, aor}, 'dialog#onMessage: response from adding dialog-info');
      })
      .catch((err) => logger.info({err, dialogInfo, aor}, 'dialog#onMessage: Error adding dialog-info'))
    ;
  }

  // is anyone subscribed to this resource / aor?
  try {
    const key = makeSubscribedResourceKey(aor);
    const subscriptions = await client.smembersAsync(key);
    logger.info({subscriptions}, `dialog#onMessage: retrieved subscriptions for ${key}`);

    for (const subscription of subscriptions) {
      try {
        logger.info(`dialog#onMessage: retrieving data for subscription ${subscription}`);
        const subscriptionData = await client.hgetallAsync(subscription);
        if (!subscriptionData) {
          logger.info(`dialog#onMessage: Error subscription not found: ${subscription}; probably expired`);
          client.sremAsync(key, subscription)
            .catch((err) => logger.error({err}, `dialog#onMessage: Error removing ${subscription} from set ${key}`));
        }
        else {
          const {dialogId} = subscriptionData;
          const body = makeXmlContent(subscriptionData, {aor, id, callId, localTag, remoteTag, direction, state});
          const req = await srf.request('sip:placeholder', {
            stackDialogId: dialogId,
            method: 'NOTIFY',
            headers: {
              'Subscription-State': 'active',
              'Content-Type': 'application/dialog-info+xml',
            },
            body
          });
          req.on('response', (res) => {
            if (200 !== res.status) logger.info(`received status ${res.status} to NOTIFY`);
          });
        }
      } catch (err) {
        logger.error({err}, `dialog#onMessage Error retrieving subscription data for ${subscription}`);
      }
    }
  } catch (err) {
    logger.error({err}, 'dialog#onMessage Error notifying suscribers');
  }
};

const makeXmlContent = (subscriptionData, dialogInfo) => {
  dialogInfo = dialogInfo || {};
  const {aor, id, callId, localTag, remoteTag, direction, state} = dialogInfo;
  let dialog = '';
  const entity = aor || subscriptionData.aor;

  if (id) {
    if (remoteTag && localTag) {
      /* eslint-disable-next-line max-len */
      dialog = `<dialog id="${id}" call-id="${callId}" local-tag="${localTag}" remote-tag="${remoteTag}" direction="${direction}"><state>${state}</state></dialog>`;
    }
    else if (remoteTag) {
      /* eslint-disable-next-line max-len */
      dialog = `<dialog id="${id}" call-id="${callId}" remote-tag="${remoteTag}" direction="${direction}"><state>${state}</state></dialog>`;
    }
    else if (localTag) {
      /* eslint-disable-next-line max-len */
      dialog = `<dialog id="${id}" call-id="${callId}" local-tag="${localTag}" direction="${direction}"><state>${state}</state></dialog>`;

    }
    else {
      dialog = `<dialog id="${id}" call-id="${callId}" direction="${direction}"><state>${state}</state></dialog>`;
    }
  }

  const content = `<?xml version="1.0"?>
<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" 
   version="${subscriptionData.count++}" 
   state="full" 
   entity="${entity}">
   ${dialog}
</dialog-info>

`;

  return content;
};

