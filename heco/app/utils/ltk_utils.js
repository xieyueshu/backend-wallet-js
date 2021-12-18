const EthereumTx = require("ethereumjs-tx");
const Web3 = require("web3");
const BigNumber = require("bignumber.js");

const logger = require("../../config/winston");
const dbUtil = require("./db_utils");

const MaxGasLimit = new BigNumber("5000000000");
const MinGasLimit = new BigNumber("500000");

const everLiankeFee = new BigNumber("50000");
const gasToLiankeRate = new BigNumber("10000000");
const gasPrice = new BigNumber("100000000000");


// sleep function
const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

// gas calculation
function calNewFee(amt) {
  BigNumber.set({ROUNDING_MODE:0});        
  const value = new BigNumber(amt);
  var liankeCount;
  var lianke = gasPrice.times(gasToLiankeRate);    
  liankeCount = new BigNumber(value.div(lianke).toFixed(0));               
  var calFeeGas = everLiankeFee.times( liankeCount);
  if (calFeeGas.toNumber()<MinGasLimit.toNumber()){            
    return MinGasLimit;
  }
  if (calFeeGas.toNumber()>MaxGasLimit.toNumber()){
    return MaxGasLimit;
  }
  return calFeeGas;
}

function gasToLianke(amt) {
  const value = new BigNumber(amt);
  return value.div(gasToLiankeRate).toNumber();
}

module.exports = {
  /**
	 * Sends LTK from one address to another
	 */
  sendLtk: async (db, wallet, callback, willAdd = true) => {
    if (wallet.toAddress.length === 0) {
      logger.info("ltk_utils.sendLtk - No receiving address supplied; unable to proceed");
      throw new Error("No receiving address supplied");
    }
    await sleep(250); // wait 250ms so that there are only 5 transactions/sec
    logger.debug("ltk_utils.sendLtk - Sleep for 200 ms");
    logger.debug(`ltk_utils.sendLtk - Transferring ${wallet.amount} from ${wallet.fromAddress} to ${wallet.toAddress}`);
    const amountToSend = wallet.amount;
    logger.debug("ltk_utils.sendLtk - amount: " + amountToSend);
    const web3 = new Web3(new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK));
    logger.debug(process.env.NODE_ETH_NETWORK);
		
    var value, to;
    value = web3.toHex( web3.toWei(amountToSend, "ether") );
    to = wallet.toAddress;
    logger.debug("Value: " + value);
	
    let nonce;
    // if the nonce has been provided, we use it
    // otherwise, get the largest nonce 
    if(wallet.nonce){
      nonce = wallet.nonce;
    }else{
      let dbNonce = await dbUtil.getMaxNonce(wallet.fromAddress, db);
      logger.debug("ltk_utils.sendLtk - DB nonce : " + dbNonce);
      let webNonce = web3.eth.getTransactionCount(wallet.fromAddress);
      logger.debug("ltk_utils.sendLtk - Web nonce: " + webNonce);

      if (dbNonce >= webNonce) {
        nonce = dbNonce + 1;
      } else {
        nonce = webNonce;
      }
    }
    logger.debug("ltk_utils.sendLtk - Transaction nonce: " + nonce);
		
    var price = "0x" + gasPrice.toString(16); 
    logger.debug("ltk_utils.sendLtk - price: " + gasPrice);
		
    // compute for the gas limit
    let gasLimit = calNewFee(web3.toWei(amountToSend,"ether"));
    logger.debug("ltk_utils.sendLtk - gas: " + gasLimit);
    gasLimit = "0x" + gasLimit.toString(16);
		
    let details = {
      to,
      value,
      gasLimit,
      nonce,
      gasPrice: price,
    };
    logger.debug("ltk_utils.sendLtk - " + JSON.stringify(details));
		
    // create, sign, and send the transaction
    const transaction = new EthereumTx(details);
    transaction.sign(Buffer.from(wallet.key.substring(2), "hex"));
    const serializedTransaction = transaction.serialize();
    const transactionId = web3.eth.sendRawTransaction("0x" + serializedTransaction.toString("hex"));
		
    logger.debug("ltk_utils.sendLtk - Transaction sent: " + transactionId);
    // we build the transaction details to be stored in the database
    let txnDetails = {
      status: "P",
      coinType: wallet.type,
      txnType: wallet.use,
      sender: wallet.fromAddress, 
      recepient: wallet.toAddress,
      amount: amountToSend,
      txnHash: transactionId,
      createTime: new Date(),
      nonce,
      timeStamp: 0,
      trace: wallet.trace,
    };

    if (willAdd) {
      try {
        await db.collection("transaction").insert(txnDetails);
        logger.info("ltk_utils.sendLtk - Inserted transaction: " + transactionId);
      } catch (err) {
        logger.error("ltk_utils.sendLtk - error occurred inserting transaction into database");
      }
    }

    if (callback) {
      try {
        callback(txnDetails);
      } catch (err) {
        logger.error("ltk_utils.sendLtk - error occurred during callback");
      }
    }

    return txnDetails;
  },
  calculateFee: calNewFee,
  gasToLianke,
};
