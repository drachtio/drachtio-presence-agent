require('dotenv').config();
const logger = require('pino')({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;},
  level: 'info'
});
const Srf = require('drachtio-srf');
const srf = new Srf(); 
const redisDb = require('./lib/redisdb');
srf.locals.redisDb = new redisDb(logger, srf);

srf.connect({
  host: process.env.DRACHTIO_HOST || '127.0.0.1',
  port: process.env.DRACHTIO_PORT || 9022,
  secret: process.env.DRACHTIO_SECRET || 'cymru'
});
srf.on('connect', (err, hp) => {
  if (err) logger.info({err}, 'Error connecting to drachtio server');
  logger.info(`successfully connected to drachtio listening on ${hp}`);
});

srf.on('error', (err) => logger.error(err));

srf.subscribe(require('./lib/subscribe')(logger));
