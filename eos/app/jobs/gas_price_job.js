const axios = require("axios");

const logger = require("../../config/winston-job");

let skiprun = 0;
var isRunning = false;

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
 */
const workEth = async (db) => {
    try {
        logger.debug("gas_price_job - Retrieving price from ethgasstation.info....");
        let response = await axios.get('https://ethgasstation.info/json/ethgasAPI.json', {
            timeout: 15000
        });
        let price = response.data.average / 10;
        logger.debug("gas_price_job - Gas price - " + price);
        await db.collection("base").updateOne({
            name: "ethGasPrice"
        }, {
            $set: {
                value: price
            }
        }, {
            upsert: true
        });
    } catch (err) {
        let gasRec = await db.collection("base").findOne({
            name: "ethGasPrice"
        });
        if (!gasRec) {
            logger.warn("gas_price_job - Unable to set gas price in db. Setting ETH gas price to 1");
            // global.ETH_GAS_PRICE = 1;
            await db.collection("base").updateOne({
                name: "ethGasPrice"
            }, {
                $set: {
                    value: 1
                }
            }, {
                upsert: true
            });
        }
        logger.error("gas_price_job - Error: " + err.stack);
    }

}

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
}

module.exports = {
    start: (db) => {
        let millisInterval = parseInt(process.env.GAS_INTERVAL) * 1000;
        logger.debug("Starting up gas_price_job. Interval: " + millisInterval);
        setInterval(gasPriceChecker, millisInterval, db);
    }
};