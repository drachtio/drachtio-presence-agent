const parseUri = require('drachtio-srf').parseUri;
const config = require('config');
const uuid = require('short-uuid')('123456789');
const _ = require('lodash');
const debug = require('debug')('drachtio:presence-agent');


const parseAor = (u) => {
  const uri = parseUri(u);
  let domain = uri.host.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
  if (domain && config.has('domain')) domain = config.get('domain');
  else if (!domain) domain = uri.host;

  return `${uri.user || 'undefined'}@${domain}`;
};

const generateETag = () => {
  return uuid.new();
};

const parseEventHeader = (event) => {
  const obj = {};
  const arr = /^(.*);(.*)$/.exec(event);
  if (!arr) {
    //Event: foo
    obj.event = event;
  }
  else {
    obj.event = arr[1].trim();
    const idMatch = /id=([^//s;]*)/.exec(arr[2]);
    if (idMatch) obj.id = idMatch[1];
  }
  debug(`parseEventHeader: Event header ${event} parsed as ${JSON.stringify(obj)}`);

  return obj;
};

const getDefaultSubscriptionExpiry = (package) => {
  if (!config.has('methods.subscribe.expire.default')) return 3600;
  const obj = _.find(config.get('methods.subscribe.expire.default'), (o, k) => {return k === package;});
  if (!obj) return 3600;
  return obj.expires;
};

module.exports = {
  parseAor,
  generateETag,
  parseEventHeader,
  getDefaultSubscriptionExpiry,
};

