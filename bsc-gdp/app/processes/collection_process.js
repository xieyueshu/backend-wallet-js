const Web3 = require("web3");
const MongoClient = require("mongodb").MongoClient;
const db = require("../../config/db");

const dbUtil = require("../utils/db_utils");
const secUtil = require("../utils/security_utils");
const settingUtil = require("../utils/setting_utils");

const ethUtil = require("../utils/eth_utils");
const collectionJob = require("../jobs/deposit_collection_job");
const logger = require("../../config/winston");

logger.info("collection_process - Child process created");
global.APP_HASH = process.argv[2];
const transactionInterval = parseInt(process.env.TRANSACTION_INTERVAL) * 1000;

MongoClient.connect(db.url, async (err, database) => {
  if (err) {
    logger.error("Unable to connect to database - " + err.stack);
    return;
  }

  logger.debug("collection_process - connected to database");
  const walletDb = database.db(db.name);
	
  // Sep 10 2020 (danie) - loaded the system addresses
  await settingUtil.loadSystemWallets(walletDb);
  // first approve the addresses before processing
  await approveEthWallets(walletDb);
  await collectionJob.process(walletDb);

  logger.info("collection_process - Finished collection job run");
  process.send("DONE");
});

// sleep function
const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const approveEthWallets = async (walletDb) => {
  if(!process.env.CHAIN_SUPPORT.includes("ETH")) return;
  const ethHotWallet = process.env.ETH_HOT_WALLET;
  const depositList = await dbUtil.getUnsentDepositAddr(walletDb, ["ETH", "AMTC"]);
  const web3 = new Web3(ethUtil.WEB3_PROVIDER);
  while(depositList && Object.keys(depositList).length > 0) {
    for(const wallet in depositList) {
      const isApproved = await ethUtil.isApprovedAddress(walletDb, ethHotWallet, wallet);
      if(isApproved){
        delete depositList[wallet];
        continue;
      } 
      if(!depositList[wallet].isDecrypted) {
        depositList[wallet].private = secUtil.decryptKey(depositList[wallet].private);
        depositList[wallet].isDecrypted = true;
      }
      await ethUtil.approveAddress(walletDb, web3, ethHotWallet, depositList[wallet]);
    }
    if(Object.keys(depositList).length > 0) {
      logger.info(`${Object.keys(depositList).length} unapproved wallets left. Waiting for ${transactionInterval} seconds. . .`);
      await sleep(transactionInterval);
    }
  }
  logger.info("Finished approving all ETH/ERC20 addresses");
};