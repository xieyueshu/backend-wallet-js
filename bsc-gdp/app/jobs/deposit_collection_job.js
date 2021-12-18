const Web3 = require("web3");

const logger = require("../../config/winston-job");
const dbUtil = require("../utils/db_utils");
const secUtil = require("../utils/security_utils");

const tronUtil = require("../utils/tron_utils");
const filUtil = require("../utils/fil_utils");
const ethUtil = require("../utils/eth_utils");

var isRunning = false;

async function depositCollection(db) {
  if (!isRunning) {
    isRunning = true;
    await runJob(db);
    isRunning = false;
  } else {
    logger.debug("Skipped deposit collection run due to ongoing operation");
  }
}

const runJob = async(db) => {
  const chainList = process.env.CHAIN_SUPPORT.split(",");
  try {
    for(const chain of chainList) {
      if(!processLib[chain]) continue;
      await processLib[chain](db);
    }
  } catch(e) {
    logger.error("deposit_collection_job - error running job: " + e.stack);
  }
};

const processLib = {
  ETH: async(db) => {
    const web3 = new Web3(ethUtil.WEB3_PROVIDER);
    const walletRec = await dbUtil.getUnsentDepositAddr(db, ["ETH", "AMTC"]);
    logger.info(`deposit_collection_job - Collecting from ${Object.keys(walletRec).length || 0} ETH/ERC20 wallets`);
    for (const wallet in walletRec) {
      try {
        if(!(await ethUtil.hasGasForTransfer(db, web3, process.env.ETH_HOT_WALLET))) {
          logger.info("deposit_collection_job - Hot wallet doesn't have enough gas. Stopping collection loop.");
          break;
        }
        const depositWallet = walletRec[wallet];
        depositWallet.private = secUtil.decryptKey(depositWallet.private);
        depositWallet.amount = depositWallet.unsent;

        const collectSuccess = await ethUtil.collectDepositWallet(db, web3, depositWallet);
        if(collectSuccess) await dbUtil.deductUnsent(db, wallet, depositWallet.amount);
      } catch (e) {
        logger.warn("deposit_collection_job - error forwarding deposit: " + e.stack);
      }
    }
  },
  TRX: async(db) => {
    const unsentList = await dbUtil.getUnsentDepositAddr(db, ["TRX", "TRC20"]);
    logger.info(`deposit_collection_job - Collecting from ${Object.keys(unsentList).length || 0} TRX/TRC20 wallets`);
    await tronUtil.transferToCold(db, unsentList);
  },
  FIL: async(db) => {
    const unsentList = await dbUtil.getUnsentDepositAddr(db, ["FIL"]);
    logger.info(`deposit_collection_job - Collecting from ${Object.keys(unsentList).length || 0} FIL wallets`);
    await filUtil.transferToCold(db, unsentList);
  }
};

module.exports = {
  start: (db) => {
    if(process.env.MANUAL_DEPOSIT === "Y") {
      logger.info("deposit_collection_job - manual collection is enabled. Shutting down job. . . ");
      return;
    }
    let millisInterval = parseInt(process.env.COLLECTION_INTERVAL) * 1000;
    logger.debug("Starting up deposit_collection_job. Interval: " + millisInterval);
    setInterval(depositCollection, millisInterval, db);
  },
  process: async(db) => {
    await depositCollection(db);
  }
};