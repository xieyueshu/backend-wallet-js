const axios = require("axios");
const BigNumber = require("bignumber.js");

const dbUtil = require("../utils/db_utils");
const logger = require("../../config/winston-job");

var isRunning = false;
const HOUR_INTERVAL = 3600;
// set the update interval to be 1 hr automatically
const UPDATE_INTERVAL = process.env.COIN_UPDATE_INTERVAL ? parseInt(process.env.COIN_UPDATE_INTERVAL) * 60 : 3600;
const HOUR_RANGE_AVE = parseInt(process.env.COIN_HOUR_AVERAGE);
const HOUR_RANGE_SEC = HOUR_RANGE_AVE * 3600;

async function amtcPriceChecker(db) {
  if (!isRunning) {
    isRunning = true;
    await work(db);
    isRunning = false;
  } else {
    logger.debug("Skipped coin_price_job run due to ongoing operation");
  }
}

const work = async (db) => {
  try {
    let coins = await getCoins(db);
    let rate = await getRateData(coins);
    let dbRate = await db.collection("base").findOne({
      name: "exchangeRates"
    });
    let currentTime = (new Date().getTime() / 1000).toFixed(0);
    let newRate = Object.keys(rate).reduce((mapped, key) => {
      const newKey = key + "Rate";
      mapped[newKey] = rate[key];
      return mapped;
    }, {}); 
    newRate.time = currentTime;

    // insert into the database the newly retrieved rate
    await db.collection("rateTick").insert(newRate);
    
    if (HOUR_RANGE_AVE === 0) {
      logger.info(`coin_price_job - Updating coin exchangeRate: ${JSON.stringify(newRate)}`);
      const updateRate = Object.keys(rate).reduce((mapped, key) => {
        const newKey = "USD." + key;
        mapped[newKey] = rate[key];
        return mapped;
      }, {});
      await db.collection("base").updateOne({
        name: "exchangeRates"
      }, {
        $set: updateRate
      });
      dbUtil.updateCoinRates(db);
    } else {
      // get the latest rate summary (average)
      let lastAverage = await getLatestAverage(db);
      logger.debug("coin_price_job - last average: " + JSON.stringify(lastAverage));

      // if there is no last average or the record is already more than an hour later than
      // the last average, create a new average record for the new hour
      // we also update the coin rate based on the average over x hours
      if (!lastAverage || isNextHour(lastAverage.time, currentTime)) {
        // we start it at the beginning of the hour 
        currentTime = new Date().setMinutes(0);
        currentTime = new Date(currentTime).setSeconds(0);
        currentTime = (currentTime / 1000).toFixed(0);

        const newRate = Object.keys(coins).reduce((mapped, coin) => {
          mapped[coin] = {
            ave: rate[coin],
            sum: rate[coin],
            count: 1,
          };
          return mapped;
        }, {});
        newRate.time = currentTime;
        logger.debug(`coin_price_job - Creating new hourly summary @ ${currentTime}`);
        await db.collection('rateSummary').insert(newRate);
      } else {
        const updatedAverage = Object.keys(rate).reduce((mapped, key) => {
          if(!lastAverage[key]) {
            lastAverage[key] = {
              count: 0,
              sum: 0
            };
          }
          let count = lastAverage[key].count || 0 + 1;
          let sum = lastAverage[key].sum || 0 + rate[key];
          let ave = (sum / count).toFixed(4);
          mapped[key] = { ave, sum, count };
          return mapped;
        }, {});

        logger.debug(`coin_price_job - Updating last summary: ${JSON.stringify(updatedAverage)}`);
        await db.collection('rateSummary').findOneAndUpdate({
          _id: lastAverage._id
        }, {
          $set: updatedAverage
        });
      }

      const lastRateUpdate = new Date(dbRate.lastUpdated).getTime() / 1000;
      if (isNextUpdate(lastRateUpdate, newRate.time)) {
        if (lastAverage) {
          // get the average of the last x hours (based on the .env settings) and update the exchange rate
          let lastAveComp = await getAverageOfLastHours(db, newRate.time, coins);
          logger.debug(`coin_price_job - Updating coin exchangeRate: ${JSON.stringify(lastAveComp)}`);
          await db.collection("base").updateOne({
            name: "exchangeRates"
          }, {
            $set: lastAveComp
          });
          await dbUtil.updateCoinRates(db);
        }
      }
    }


  } catch (err) {
    logger.error("coin_price_job error: " + err.stack);
  }
}

const getCoins = async (db) => {
  logger.debug("Getting coins");
  const coins = {};

  // for older-version support (< 9.0.0)
  if (process.env.AMTC_PRICE_URL) {
    coins.amtc = { priceUrl: process.env.AMTC_PRICE_URL };
  } 
  if (process.env.ETH_PRICE_URL) {
    coins.eth = { priceUrl: process.env.ETH_PRICE_URL };
  } 
  if (process.env.BTC_PRICE_URL) {
    coins.btc = { priceUrl: process.env.BTC_PRICE_URL };
  }

  const coinsDb = await db.collection("coin_setting").find().toArray();
  for(const setting of coinsDb) {
    if (setting.priceUrl) {
      coins[setting.coin.toLowerCase()] = { priceUrl: setting.priceUrl };
    }
  }
  return coins;
}

const getRateData = async (coins) => {
  const coinsWithRate = {};
  for (const key in coins) { 
    if(!coins.hasOwnProperty(key)) continue;
    const json = await axios.get(coins[key]['priceUrl'], {
      timeout: 15000
    });
    const details = json.data;
    coinsWithRate[key] = getLastTick(coins[key]['priceUrl'], details);
  }
  
  return coinsWithRate;
}

const getLastTick = (url, response) => {
  let tick = 0;
  if (url.includes("exczc")) {
    tick = response.data.last;
  } else if (url.includes("vvbtc")) {
    tick = response.tick.last;
  } else if (url.includes("exx")) {
    tick = response.ticker.last;
  } else if (url.includes("ubcoin.pro")) {
    tick = response.data.close;
  }
  return new BigNumber(tick).toNumber();
}

const isNextHour = (last, current) => {
  last = last || 0
  logger.debug(`coin_price_job - Gap between last average: ${current - last}`);
  return current - last >= HOUR_INTERVAL;
}

const isNextUpdate = (last, current) => {
  last = last || 0
  logger.debug(`coin_price_job - Gap between last update: ${current - last}`);
  return current - last >= UPDATE_INTERVAL;
}

const getLatestAverage = async (db) => {
  let sumDb = await db.collection('rateSummary').find().sort({
    time: -1
  }).limit(1).toArray();
  if (sumDb.length === 0) return null;

  return sumDb[0];
}

const getAverageOfLastHours = async (db, currentTime, coins) => {
  const earliestTime = currentTime - HOUR_RANGE_SEC;
  const aveGrp = await db.collection('rateTick').find({
    time: {
      $gte: earliestTime.toString()
    }
  }).toArray();
  let totalCnt = aveGrp.length;
  const totals = Object.keys(coins).reduce((mapped, key) => {
    mapped[key] = 0;
    return mapped;
  }, {});

  aveGrp.reduce((newAve, rate) => {
    Object.keys(coins).forEach((coin) => {
      const key = coin + "Rate";
      totals[coin] += rate[key] || 0;
    });
  }, {});

  const lastAve = {};
  Object.keys(totals).forEach((coin) => {
    const key = "USD." + coin; 
    lastAve[key] = totals[coin] / totalCnt;
  });
    
  return lastAve;
}

module.exports = {
  start: (db) => {
    let millisInterval = parseInt(process.env.COIN_PRICE_INTERVAL) * 1000;
    logger.debug("Starting up coin_price_job. Interval: " + millisInterval);
    setInterval(amtcPriceChecker, millisInterval, db);
  },
  test: (db) => {
    return amtcPriceChecker(db);
  }
};