// Sep 10 2020 (danie) - added retrieval of env settings
const logger = require("../../config/winston");
const secUtil = require("../utils/security_utils");

module.exports = {
  // list of settings that are present in the .env
  // Sep 16 (danie) - added ETH_HOT_GAS_TRANSFER 
  // Sep 16 (danie) - added ETH_GAS_PRICE_MULTIPLIER 
  envSettingList: [
    "SUCCESS_DEPOSIT_URL",
    "SUCCESS_WITHDRAW_URL",
    "SUCCESS_SEND_URL",
    "REJECT_WITHDRAW_URL",
    "ETH_HOT_GAS_TRANSFER",
    "ETH_GAS_PRICE_MULTIPLIER"
  ],
  loadSettings: async (db) => {
    logger.info("setting_utils.loadSettings - Reloading settings");
    let settings = await db.collection("base").findOne({
      name: "settings"
    }, {
      fields: {
        _id: 0,
        name: 0
      }
    });
    if (!settings) {
      await db.collection("base").insert({
        name: "settings"
      });
      logger.info("setting_utils.loadSettings - Created Settings object");
    } else {
      for (let name in settings) {
        if (Object.prototype.hasOwnProperty.call(settings, name)) {
          logger.debug("setting_utils.loadSettings - reloading " + name);
          process.env[name] = settings[name];
        }
      }
      logger.info(`setting_utils.loadSettings - Reloaded ${Object.keys(settings).length} settings`);
    }
  },
  // Sep 10 2020 (danie) - implemented loading of system wallets
  loadSystemWallets: async (db) => {
    logger.info("setting_utils.loadSystemWallets - Loading system addresses");
    let systemRecords = await db.collection("system_address").find({}).toArray();
    if (systemRecords.length === 0) {
      logger.info("Unable to find system addresses");
    } else {
      for (let record of systemRecords) {
        const type = record.type;
        logger.info("Loaded system addresses for " + type);                
        process.env[`${type}_HOT_WALLET`] = record.hotAddress;
        if (record.hotSecret){
          process.env[`${type}_HOT_WALLET_SECRET`] = secUtil.decryptKey(record.hotSecret);
        }
        process.env[`${type}_COLD_WALLET`] = record.coldAddress;
            
        logger.info("setting_utils.loadSystemWallets - Finished loading system addresses");
      }
    }
  },

  getSetting: (db, name = "") => {
    logger.debug("setting_utils.getSetting - Retrieving setting " + name);
    let fields = {
      _id: 0
    };
    if (name) {
      fields[name] = 1;
    } else {
      fields["name"] = 0;
    }
    return db.collection("base").findOne({
      name: "settings"
    }, {
      fields
    });
  },
  getEnvSettings: async (db) => {
    const dbSettings = await db.collection("base").findOne({name: "settings"});
    const settings = {};
    for ( const key of module.exports.envSettingList) {
      settings[key] = dbSettings[key] || process.env[key];
    }
    return settings;
  }
};