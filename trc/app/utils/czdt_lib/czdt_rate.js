const BigNumber = require("bignumber.js");

const logger = require("../../../config/winston");
const dbUtil = require("../db_utils");

module.exports = {
  getRate: async (db) => {
    try {
      const czdtRate = await dbUtil.getCurrencyRate(db, "CNY");
      logger.info(`czdt rate: ${czdtRate}`);
      return BigNumber(czdtRate).toFixed(4, 3).toString();
    } catch (e) {
      logger.error("Error while retrieving rate: " + e.stack);
      return -1;
    }
  },
  getRewards: (data) => {
    let rewards = {};
    let regmoney = BigNumber(data.amount).div(data.rate);
    rewards["RP"] = regmoney.toFixed(2, 3).toString();

    let addrList = [];
    if (addrList.includes(data.address)) {
      // add the marked wallet bonus here
    }
    return rewards;
  }
};