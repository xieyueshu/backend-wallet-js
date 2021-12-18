const BigNumber = require("bignumber.js");

const logger = require("../../../config/winston-job.js");

const web3Lib = require("./web3_lib");
const settingUtils = require("../setting_utils");
const axios = require("axios");

module.exports = {
  async unableToSendGas(gasAmtTransfer, address, web3, db, gasWithMultiplier) {
    if (gasAmtTransfer.isEqualTo(0)) {
      logger.debug(`eth_utils.transferGas - ${address} already has enough gas`);
      return true;
    }
    const settings = await settingUtils.getSetting(db, "ETH_HOT_GAS_TRANSFER");
    if (gasAmtTransfer.isGreaterThan(settings.ETH_HOT_GAS_TRANSFER)) {
      logger.info("eth_utils.transferGas - Eth requirement for gas is too high: " + gasAmtTransfer.toString());
      return true;
    }
    if (await hasEnoughBalanceForGas(web3, db, gasWithMultiplier)) {
      logger.info("eth_utils.transferGas - " + process.env.ETH_HOT_WALLET + " doesn't have enough ETH for gas transfer to " + address);
      return true;
    }
    
    return false;
  },

  async retrieveGasPriceFromAPI(db) {
    let price = 1;
    try {
      logger.info("sendHelper - retrieving gas price from ethgasstation");
      let response = await axios.get("https://ethgasstation.info/json/ethgasAPI.json", { timeout: 15000 });
      price = response.data.fast / 10;
    } catch (err) {
      logger.error("getAverageGasPrice - error : " + err);
    }
    await db.collection("base").updateOne({ name: "ethGasPrice" }, { $set: { value: price } }, { upsert: true });
    return price;
  },
  
  async getAverageGasPrice (db) {
    let priceRec = await db.collection("base").findOne({ name: "ethGasPrice" });
    let price = priceRec.value;
    if (!price) {
      logger.warn("sendHelper - gas price not found in system");
      price = await module.exports.retrieveGasPriceFromAPI(db);
    }
    return price;
  },
};

async function hasEnoughBalanceForGas(web3, db, gasWithMultiplier) {
  let hotWei = await web3Lib.getBalance(web3, process.env.ETH_HOT_WALLET);
  let hotEthBalance = BigNumber(web3.fromWei(hotWei, "ether"));

  const gasPrice = web3.fromWei(await module.exports.getAverageGasPrice(db), "gwei");
  const gasRequired = new BigNumber(gasPrice).times(process.env.ETH_GAS_LIMIT);
  const totalGasRequired = gasRequired.plus(gasWithMultiplier);
  logger.info(`eth balance: ${hotEthBalance.toString()}, required gas: ${totalGasRequired.toString()}`);
 
  return hotEthBalance.lt(totalGasRequired);
}
