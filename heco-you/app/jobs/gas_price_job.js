const axios = require("axios");

const logger = require("../../config/winston-job");

let skiprun = 0;
var isRunning = false;

const ethGasHelper = require("../utils/eth_lib/gas.helper");

async function gasPriceChecker(db) {
  if (!isRunning) {
    isRunning = true;
    logger.debug("gas_price_job - running");
    if(process.env.CHAIN_SUPPORT.includes("ETH"))
      await workEth(db);
    if(process.env.CHAIN_SUPPORT.includes("BTC"))
      await workBtc(db);
    isRunning = false;
  } else {
    skiprun += 1; // add to the number of times the job has been skipped 
    logger.debug("Skipped gas_price_job run due to ongoing operation");
    if (skiprun > 15) { // if the job has been skipped 15 times, reset the flag and let the job run again
      logger.warn("Gas price job has been skipped 15 times.. resetting job flag...");
      isRunning = false;
    }
  }
}

/**
 * Checks for the price of gas from the web
 * @param {db object used to perform db operations} db 
 * Oct 15 2020 (Danie) - used fast when retrieving gas price
 * May 20 2021 (Danie) - used eth gas helper
 */
const workEth = ethGasHelper.retrieveGasPriceFromAPI;

const workBtc = async (db) => {
  try {
    logger.debug("gas_price_job - Retrieving price from bitcoinfees.info....");
    let response = await axios.get(process.env.BTC_FEE_URL, {
      timeout: 15000
    });
    const price = response.data;
    logger.debug("gas_price_job - Gas price - " + JSON.stringify(price));
    await db.collection("base").updateOne(
      {name: "btcGasPrice" }, { $set: { value: price } }, { upsert: true }
    );
  } catch (err) {
    logger.error("gas_price_job - Error: " + err.stack);
  }
};

module.exports = {
  start: (db) => {
    let millisInterval = parseInt(process.env.GAS_INTERVAL) * 1000;
    logger.debug("Starting up gas_price_job. Interval: " + millisInterval);
    setInterval(gasPriceChecker, millisInterval, db);
  },
  test: async (db) => {
    await gasPriceChecker(db);
  }
};