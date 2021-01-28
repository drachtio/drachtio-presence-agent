module.exports = function(logger, client, srf) {
  return {
    dialog: require('./packages/dialog')(logger, client, srf)
  };
};
