require("dotenv").config();
const logger = require("./config/winston");
const axios = require("axios");
const BigNumber = require("bignumber.js");
const Web3 = require("web3");

const TRCEXPLORER = "https://trx.tokenview.com/api/trx/address/tokenbalance";
const TRXEXPLORER = "https://trx.tokenview.com/api/address/balancetrend/trx";
const WEB3_PROVIDER = new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK,parseInt(process.env.NODE_ETH_TIMEOUT),process.env.NODE_ETH_USER,process.env.NODE_ETH_PASS);

// sleep function
const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const getTrxBalance = async (address, contract) => {
  if (contract) {        
    const result = await axios.get(TRCEXPLORER + "/" + address.trim());        
    if(!result.data.data) {
      logger.warn("No data found for " + address);
    } else {
      const entry = result.data.data.find(token => (token.tokenInfo.h == contract.hash));
      if (entry) {            
        return new BigNumber(entry.balance).shiftedBy(contract.decimals * -1).toNumber();
      }
    }
  } else {
    try {
      const trxResult = await axios.get(TRXEXPLORER + "/" + address);
      return Object.values(trxResult.data.data[0])[0];
    } catch (e) {
      logger.error(e);
    }
  }
  return 0;
};

const getTokenBalance = (web3, address, contract) => {
  let tknAddress = (address).substring(2);
  // hash of the "retrieve balance" for tokens
  let contractData = ("0x70a08231000000000000000000000000" + tknAddress);
  return new Promise((resolve, reject)  => {
    web3.eth.call({
      to: contract.hash,
      data: contractData
    }, (err, tknResult) => {
      if(err) reject(err);
      let tknAmt = new BigNumber(tknResult).shiftedBy(contract.decimals * -1).toNumber();
      resolve(tknAmt);
    });
  });
};

const getEthBalance = async (address, contract) => {    
  const web3 = new Web3(WEB3_PROVIDER);
  try {
    if (contract) {
      return getTokenBalance(web3, address, contract);
    } else {
      return web3.eth.getBalance(address);
    }
  } catch(err) {
    logger.warn(`Error getting Eth Balance: ${err.stack}`);
    return 0;
  }
};

const BALANCE_GETTER = {
  trx: getTrxBalance,
  eth: getEthBalance
};

const checkForUncollected = async (db, addresses, coin, contract) => {
  const getBalance = BALANCE_GETTER[coin];
  if (getBalance==null) {
    logger.error("unsupported coin type : " + coin);
    return;
  }    
  logger.info(`retrieved ${addresses.length} addresses`);
  for (let i = 0, j = addresses.length; i < j; i++) {
    const address = addresses[i]._id;        
    logger.debug("checking address " + i + " " + address);
    const balance = await getBalance(address, contract);
    if (balance > 0) {
      let record = await db.collection("address").findOne({ address });
      if (record) {
        //only update the db record if unsent is smaller than actual balance
        const unsent = record.unsent || 0;
        const unsentDifference = new BigNumber(balance).minus(unsent);
        if (unsentDifference.isGreaterThan(0)) {
          //we just increment by the difference to make sure that we don't try to collect more than available which will result to failure.
          logger.info("adding unsent to :" + address + " for the amount of " + (balance - unsent) + " actual balance is: " + balance);
          //temporarily comment out so we can test if correct
          await db.collection("address").findOneAndUpdate({_id:record._id}, {$inc: {unsent: unsentDifference.toNumber()}});
        } else {
          if (balance>0){
            logger.info("unsent balance for:" + address + " is  " + unsent + " actual balance is: " + balance + ". Skipping update.");
          }
        }
      } else {
        logger.error("unexpected error! unable to find record in address collection for : " + address);
      }
    }
    await sleep(300);
  }
};

module.exports = checkForUncollected;