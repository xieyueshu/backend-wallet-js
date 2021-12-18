const axios = require("axios");

const dbUtil = require("../utils/db_utils");
const logger = require("../../config/winston-job");

var isRunning = false;

async function currencyRateChecker(db) {
    if (!isRunning) {
        isRunning = true;
        await work(db);
        isRunning = false;
    } else {
        logger.debug("Skipped currency_rate_job run due to ongoing operation");
    }
}

/**
 * Checks for the price of gas from the web
 * @param {db object used to perform db operations} db 
 */
const work = async (db) => {
    logger.debug("currency_rate_job - running");
    try {
        logger.debug("currency_rate_job - Retrieving currency from free.currencyconverterapi.com....");
        let response = await axios.get(process.env.CURRENCY_API_URL, {
            timeout: 15000
        });
        let results = response.data.results;
        let convert = {};
        // for each of the currencies in the result, add them to an object
        for (let cur in results) {
            if (results.hasOwnProperty(cur)) {
                let to = results[cur]["to"];
                convert[to] = results[cur]["val"];
            }
        }
        logger.debug("currency_rate_job - " + JSON.stringify(convert));
        convert["lastUpdated"] = new Date().toTimeString();
        await db.collection("base").findOneAndUpdate({
            name: "currencyRates"
        }, {
            $set: convert
        }, {
            upsert: true
        });
        await dbUtil.updateCoinRates(db);
    } catch (err) {
        logger.error("currency_rate_job - Error: " + err.stack);
    }


}

module.exports = {
    start: (db) => {
        let millisInterval = parseInt(process.env.CURRENCY_INTERVAL) * 1000;
        logger.debug("Starting up currency_rate_job. Interval: " + millisInterval);
        setInterval(currencyRateChecker, millisInterval, db);
    }
};