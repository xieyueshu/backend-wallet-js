const BigNumber = require("bignumber.js");

const secUtil = require("./security_utils");
const filecoin = require("./fil_lib/filecoin");
const dbUtils = require("./db_utils");
const createHelper = require("./chain_lib/create_wallet.helper");
const logger = require("../../config/winston");

const COIN_TRANSFER_MIN = new BigNumber(process.env.FIL_COIN_TRANSFER_MIN || "0");

module.exports = {
  createWallet : async (res, db) => {
    logger.debug("fil_utils.createWallet - generating FIL address");	
    let wallet = await filecoin.newWallet();
    let addressRec = {
      type : "FIL",
      use : "D",
      address: wallet.address,
      private : secUtil.encryptKey(JSON.stringify(wallet.private))
    }; 
    logger.info("FIL address generated: " + wallet.address);

    const success = await createHelper.insertIntoDb(addressRec, db, res);
    if(!success) return;
    createHelper.sendAddressAndBackUpToFile(addressRec);

    createHelper.encryptSecretForResponse(addressRec, wallet.private, false);
    return createHelper.sendReponse(addressRec, res);
  },
  
  isAddress : async (address)=>{
    let result =await filecoin.validateAddress(address);
    return result;
  },
  
  getBalance: async (address) => {
    let balance= await filecoin.getBalance(address);	 	      
    return balance;	
  },
  
  sendFil: async (db, wallet, subtractFee=false) => {
    logger.info(`fil_utils.send - Sending ${wallet.amount} ${wallet.type} from ${wallet.fromAddress} to ${wallet.toAddress}`);		
    try {
      let txn =await filecoin.sendFil(wallet, subtractFee);			
      logger.info("Transaction with ID " + txn.txnHash + " created");
      txn.createTime=new Date();		
      try {
        await db.collection("transaction").insertOne(txn);
        logger.info("fil_utils.sendFil - Inserted transaction: " + txn.txnHash);
      } catch (err) {
        logger.error("fil_utils.sendFil - error occurred inserting transaction into database" + err.stack);
      }
      return txn;
    } catch (e){
      logger.error("fil_utils.sendFil - error occured sending Fil " + e.stack);
      throw e;
    }
  },
  
  createWithdrawRequest: async (withdraw, db, after) => {
    try {			
      const coinType = withdraw.type.toUpperCase();			
      const hotAddress = { address: process.env.FIL_HOT_WALLET};

      const processedList = await dbUtils.processWithdrawRequestList(db, module.exports, after, withdraw.request);
      if(!processedList) return;
      const totalAmount = processedList.totals.totalAmount.toString();			
      const approvedStatus = await dbUtils.getWithdrawApprovalStatus(withdraw, coinType, totalAmount);

      const requestDetails = await dbUtils.insertWithdrawRequest(db, processedList, coinType, approvedStatus, hotAddress.address);
      after(requestDetails);
    } catch (err) {
      logger.error("fil_utils.createWithdrawRequest - " + err.stack);
      after({
        error: "An error occurred while processing the request"
      });
    }
  },
  getLastBlockNum: async () => {
    return await filecoin.getLastBlockNum();
  },
  getTransactionList: async(blockNum) => {
    return await filecoin.getBlockTransfersByExplorer(blockNum);		
  },
  getTransactionInfo : async(txnHash)=>{
    return await filecoin.getTxnReceipt(txnHash);
  },
  transferToCold: async(db, unsentList) => {
    for(const addr in unsentList) {
      const addrRec = unsentList[addr];
      let unsent = await filecoin.getBalance(addr);
      //skip addresses with minimum balance
      if(new BigNumber(unsent).lt(COIN_TRANSFER_MIN) || new BigNumber(unsent).eq(0)) {
        logger.debug(`Address ${addr} doesn't meet minimum coin amount transfer: ${unsent}/${COIN_TRANSFER_MIN.toString()}`);				
      } else {
        try {				
          const request = {
            fromAddress: addr,
            toAddress: process.env.FIL_COLD_WALLET,					
            amount: addrRec.unsent,
            use: "T",
            type: addrRec.type
          };
          await module.exports.sendFil(db, request, true);
          unsent = 0;
        } catch (e) {
          logger.error("fil_utils.transferToCold - Error sending out from " + addr + ": " + e.stack||e.message);
        }
      }
      logger.debug(`fil_utils.transferToCold - setting unsent for ${addr} to ${unsent}`);
      await db.collection("address").findOneAndUpdate({address: addr}, { $set: {unsent: new BigNumber(unsent).toNumber()}});
    }
  },
  getActualAmount: (value)=>{
    return filecoin.parseValueAsFil(value);
  }, 
  filToAttoFil : (value)=>{
    return new BigNumber(filecoin.filToAttoFilString(value));
  },
  attoFilToFil : (value)=>{
    return new BigNumber(filecoin.attoFilToFilString(value));
  }
};
