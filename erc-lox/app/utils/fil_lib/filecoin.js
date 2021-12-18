const BigNumber = require("bignumber.js");
const rpc = require("./rpc");
const FC_CONST = require("./constants");
const UNITS = {
  "ATTOFIL" : -18,
  "PICOFIL" : -12,
  "NANOFIL" : -9,
  "FIL" : 0
};

/**
  creates a new wallet address in the lotus node and return its address and private key 
  returns: {address , private}
*/
const newWallet = async()=> {	
  let rpcWalletNew = await rpc.call(FC_CONST.RPC_WALLET_NEW, [process.env.FIL_WALLET_TYPE]);
  let address= rpcWalletNew.result;
  let rpcWalletExport = await rpc.call(FC_CONST.RPC_WALLET_EXPORT,[address]);
  let private = rpcWalletExport.result;
  return {		
    address,		
    private
  };		
};


/**
   returns the block number of the last block;
   returns: number
*/
const getLastBlockNum = async() =>{
  let rpcChainHead = await rpc.call(FC_CONST.RPC_CHAIN_HEAD,[]);	
  return rpcChainHead.result.Height;
};

/**
  converts an amount from fil to attoFil then return as string
  returns:  String
*/
const filToAttoFilString = (amount)=>{
  return new BigNumber(amount).shiftedBy(18).toFixed(0,1).toString();	
};

const MIN_FEE=new BigNumber(filToAttoFilString(process.env.FIL_FEE_MIN));

/**
  converts an amount from attoFil to fil then return as string
  returns:  String
*/
const attoFilToFilString = (amount)=>{
  return new BigNumber(amount).shiftedBy(-18).toString();	
};

/**
  return the balance of an address that is within this wallet node in fil denomination
  returns: String
*/
const getBalance = async(address)=>{
  let rpcWalletBalance = await rpc.call(FC_CONST.RPC_WALLET_BALANCE, [address]);
  return attoFilToFilString(rpcWalletBalance.result);
};

/**
  Validates if the given address is a valid filecoin address
  returns: boolean
*/
const validateAddress = async(address)=>{		
  let rpcWalletValidateAddress = await rpc.call(FC_CONST.RPC_WALLET_VALIDATE_ADDRESS, [address]);	
  return rpcWalletValidateAddress.result!=undefined;
};

/**
  Returns the list of addresses inside this wallet node  
*/
const listAddresses = async()=>{	
  let rpcWalletList = await rpc.call(FC_CONST.RPC_WALLET_LIST, []);
  return rpcWalletList.result;
};
/**
  perform send coin operation, input is a transaction object containing the following fields:
  {
    fromAddress : (String),
    toAddress   : (String),
    amount      : (number or string in Fil denomination),
  }
  Gas fees are automatically calculated, fromAddress must be an address within the node
  if operation is success, returns an object containing the details of the operation
  else throw error.
  
  returns: {status, sender, recipient, amount, txnHash, nonce, gasLimit, gasFeeCap, gasPremium}
*/
const sendFil = async(txn,subtractFee=false)=>{	
  let toSend= filToAttoFilString(txn.amount);	
  if (subtractFee){
    //we estimate how much gas we will use at most		
    BigNumber.config({ EXPONENTIAL_AT: 28 });
    toSend  = new BigNumber(filToAttoFilString(txn.amount)).minus(MIN_FEE).toString();						
  }
  if (new BigNumber(toSend).isNegative()) {
    throw new Error("not enough balance to transfer");
  }	
  
  let message = {
    "Version" : 0,
    "To" : txn.toAddress,
    "From" : txn.fromAddress,
    "Value" : toSend,
    "Method" : 0,
    "Params": ""
  };
  await setGasDetails(message);
  let rpcMpoolPushMessage = await rpc.call(FC_CONST.RPC_MPOOL_PUSHMESSAGE, [message,{"MaxFee":"0"}]);
  if (rpcMpoolPushMessage.result){				
    return {
      status: "P",
      coinType: "FIL",
      txnType: txn.use,
      sender : message.From,
      from:message.From,
      recepient: message.To,
      amount : Number(attoFilToFilString(toSend)),
      txnHash : rpcMpoolPushMessage.result.CID["/"],
      trace: txn.trace,			
      nonce : rpcMpoolPushMessage.result.Message.Nonce,
      gasLimit: rpcMpoolPushMessage.result.Message.GasLimit,
      gasFeeCap: rpcMpoolPushMessage.result.Message.GasFeeCap,
      gasPremium: rpcMpoolPushMessage.result.Message.GasPremium
    };
  } else {
    throw new Error(rpcMpoolPushMessage.error.message);
  }
};

const setGasDetails = async (message) => {
  let rpcGasEstimateMessageGas = await rpc.call(FC_CONST.RPC_GAS_ESTIMATE_MESSAGE_GAS, [message,{"MaxFee":"0"},[]]);
  message.GasLimit = new BigNumber(process.env.FIL_GAS_LIMIT_MULTIPLIER || 1).times(rpcGasEstimateMessageGas.result.GasLimit).toNumber();
  message.GasFeeCap = new BigNumber(process.env.FIL_GAS_CAP_MULTIPLIER || 1).times(rpcGasEstimateMessageGas.result.GasFeeCap).toString();		
  message.GasPremium = new BigNumber(process.env.FIL_GAS_PREMIUM_MULTIPLIER || 1).times(rpcGasEstimateMessageGas.result.GasPremium).toString();
};

/**
 estimate the gas to be used by the transaction
 returns: attoFil denominated gas
*/
const estimateGas = async(txn)=>{
  
  let message = {
    "Version" : 0,
    "To" : txn.toAddress,
    "From" : txn.fromAddress,
    "Value" :  filToAttoFilString(txn.amount),
    "Method" : 0,
    "Params": ""
  };
  let rpcGasEstimateMessageGas = await rpc.call(FC_CONST.RPC_GAS_ESTIMATE_MESSAGE_GAS, [message,{"MaxFee":"0"},[]]);
  if (rpcGasEstimateMessageGas.result){	
    let gasLimit = new BigNumber(rpcGasEstimateMessageGas.result.GasLimit);
    let gasFeeCap = new BigNumber(rpcGasEstimateMessageGas.result.GasFeeCap);		
    return gasLimit.multipliedBy(gasFeeCap);		
  } else {
    throw new Error(rpcGasEstimateMessageGas.error.message);
  }	
};
/**
  return the list of transaction hashes in a block height, Filecoin's retrieval api are dependent on the block hashes
  returns: array of cids (transaction hashes)
*/
const getCidsByBlock = async (blockNum) =>{
  let rpcChainGetTipSetByHeight = await rpc.call(FC_CONST.RPC_CHAIN_GET_TIP_SET_BY_HEIGHT, [blockNum,[]]);
  return rpcChainGetTipSetByHeight.result.Cids;	
};

/**
  return all the transfer transactions within a given block hash cid (block hash)
  this api is dependend on the explorer, and there could potentially be rate limits
  need to test to be sure later.
  returns: array of successful transfer transactions within a block hash. 
*/


const getHashTransfersByExplorer = async (cid) => {		
  let expSpecCount = await rpc.expl(FC_CONST.EXP_SPEC_COUNT,{block_cid: cid, method:"Transfer"});
  let cnt = expSpecCount.data.data;		
  let result=[];
  if (cnt>0){
    let page=1;				
    while (cnt>0){	   
      let expTransfers= await rpc.expl(FC_CONST.EXP_SPEC_LIST,{block_cid: cid, method:"Transfer", page: page , page_size:100});						
      result=result.concat(expTransfers.data.data.data.filter(txn => {return txn["exit_code_name"]=="OK";}));			
      page=page+1;
      cnt =cnt-100;
    }	
  } 	
  return result;
};

const getHashTransfersByExplorer2 = async (cid) => {			
  let expMsgList = await rpc.expl2(FC_CONST.EXP_MSG_LIST,{cid: cid}, {method:"Send", pageSize:100});
  let cnt = expMsgList.data.totalCount;		
  // 2021/01/21 (danie) - added checking if txn.receipt is set before checking exit code
  let result=expMsgList.data.messages.filter(txn=> {return txn.receipt && txn.receipt.exitCode==0;});	
  if (cnt>100){
    let page=1;				
    while (cnt>0){	   			
      let expTransfers= await rpc.expl2(FC_CONST.EXP_MSG_LIST,{cid:cid}, {method:"Send", page: page , page_size:100});			
      result=result.concat(expTransfers.data.messages.filter(txn => {return txn.receipt && txn.receipt.exitCode==0;}));			
      page=page+1;
      cnt =cnt-100;
    }	
  } 	
  return result;
};

/**
  return the list of transfers within a given block  
  returns: array of transfer transactions {cid, block_height, timestamp, timestamp_str,timestamp_format,from, to, to_type,value_str,method,to_actor_type,exit_code_name,gas_fee_str}
*/
const getBlockTransfersByExplorer = async (blockNum) => {
  let cids =await getCidsByBlock(blockNum); 
  let result=[];
  for (let i=0,j=cids.length;i<j;i++){	  
    result=result.concat(await getHashTransfersByExplorer2(cids[i]["/"]));
  }     
  return result;
};

const parseValueAsFil =(value)=>{
  if (value.trim().length<1) return 0;	
  let parts = value.trim().split(" ");
  if (parts.length<2) return NaN;
  let unit = parts[1].toUpperCase();
  let amount = new BigNumber(parts[0].replaceAll(",",""));
  return amount.shiftedBy(UNITS[unit]);   
};

const getTxnReceipt = async (txnHash) =>{
  let rpcStateSearchMsg = await rpc.call(FC_CONST.RPC_STATE_SEARCH_MSG, [{"/": txnHash}]);
  if (rpcStateSearchMsg.result){
    return {
      blockNumber : rpcStateSearchMsg.result.Height,
      gasFee : new BigNumber(attoFilToFilString(rpcStateSearchMsg.result.Receipt.GasUsed)).toNumber(),
      success: rpcStateSearchMsg.result.Receipt && rpcStateSearchMsg.result.Receipt.ExitCode==0
    };
  } else {
    return null;
  }
};
  
module.exports = {
  newWallet,
  getLastBlockNum,
  listAddresses,
  filToAttoFilString,
  attoFilToFilString,
  parseValueAsFil,
  getBalance,
  getBlockTransfersByExplorer,
  getHashTransfersByExplorer,
  validateAddress,
  sendFil,
  getTxnReceipt,
  estimateGas	
};
