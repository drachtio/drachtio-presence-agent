# drachtio-presence-agent

A basic State Agent as per [RFC 3265](https://tools.ietf.org/html/rfc3265).

## Configuring
Edit the .env file as appropriate.  Note that the drachtio and redis configuration parameters default to the local machine and well-known ports if not supplied.
```
DRACHTIO_HOST=<ip of drachtio server>
DRACHTIO_PORT=<drachtio server admin port>
DRACHTIO_SECRET=>drachtio server shared secret>
REDIS_HOST=<ip of redis server>
REDIS_PORT=<tcp port to connect to redis server>
# SUPPORTED_EVENTS is a comma-separated of events to manage subscriptions for
SUPPORTED_EVENTS=dialog
```

## Event Packages
This application currently supports only the 'dialog' event package ([RFC 4235](https://tools.ietf.org/html/rfc4235)).  Since each event package will require different information to be stored and notified, the application is designed to dynamically load event package implementations from the `lib/events/packages` folder.  For example, the 'dialog' package is implemented by `lib/events/packages/dialog.js`.  In this way, you should be easily able to add support for additional events.

