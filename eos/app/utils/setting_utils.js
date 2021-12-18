const logger = require("../../config/winston");

module.exports = {
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
                if (settings.hasOwnProperty(name)) {
                    logger.debug("setting_utils.loadSettings - reloading " + name);
                    process.env[name] = settings[name];
                }
            }
            logger.info(`setting_utils.loadSettings - Reloaded ${Object.keys(settings).length} settings`);
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
            fields["name"] = 0
        }
        return db.collection("base").findOne({
            name: "settings"
        }, {
            fields
        });
    }
}