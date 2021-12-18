const logger = require("../../config/winston");

let baseDict = {}

module.exports = {
  loadValue: async(db, name) => {
    await module.exports.getValueDb(db, name);
  },
  // retrieves from the db and loads it into the cache
	getValueDb: async(db, name) => {
		const item = await db.collection("base").findOne({
      name
    });
    baseDict[name] = item.value;
    logger.debug(`Retrieved value for "${name}" from database`);
		return item.value;
  },
  hasValue: (name) => {
    return baseDict.hasOwnProperty(name);
  },
  getValueMem: (name) => {
    return baseDict[name];
  }
}