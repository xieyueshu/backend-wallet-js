// Sep 9 2020 (Danie) - Refactored web3 provider
// Oct 09 2020 (danie) - changed transfer to cold to use approve
// Oct 16 2020 (danie) - updated gas settings to be from settings util
const Web3 = require("web3");
const Web3Eth = require("web3-eth");
const bip39 = require("bip39");
const ethers = require("ethers");
const BigNumber = require("bignumber.js");

const logger = require("../../config/winston");
const dbUtil = require("./db_utils");
const ltkUtil = require("./ltk_utils");
const otherEthUtil = require("./other_eth_utils");
const secUtil = require("./security_utils");
const settingUtil = require("./setting_utils");

const createHelper = require("./chain_lib/create_wallet.helper");
const sendHelper = require("./chain_lib/chain_send.helper");
const ethDb = require("./eth_lib/eth_db");
const ethSend = require("./eth_lib/send.helper");
const gasHelper = require("./eth_lib/gas.helper");
const web3Lib = require("./eth_lib/web3_lib");


const WEB3_PROVIDER = new Web3.providers.HttpProvider(process.env.NODE_ETH_NETWORK,parseInt(process.env.NODE_ETH_TIMEOUT),process.env.NODE_ETH_USER,process.env.NODE_ETH_PASS);
const web3Eth = new Web3Eth(process.env.NODE_ETH_NETWORK);
// sleep function
const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};


const getAMTCAmount = (amount, decimals = ethSend.DEFAULT_CONTRACT_DECIMAL) => {
  return BigNumber(amount).div(BigNumber(BigNumber(10).pow(decimals)));
};

/**
 * Get average gas stored in the system. Retrieve from the web if there is none.
 */
const getAverageGasPrice = gasHelper.getAverageGasPrice;

module.exports = {
  getAMTCAmount,
  getAverageGasPrice,
  getBalance: web3Lib.getBalance,
  getBlock: web3Lib.getBlock,
  getLatestBlock: web3Lib.getLatestBlock,
  getReceipt: web3Lib.getReceipt,
  getTransaction: web3Lib.getTransaction,
  isApprovedAddress: ethDb.isApprovedAddress,
  WEB3_PROVIDER: WEB3_PROVIDER,
  /**
	 * Sends tokens from an address to another 
	 * using the supplied contract
	 */
  send: async (db, wallet, callback, willAdd = true) => {
    // if LTK support has been enabled, use the ltk sending method instead
    if(process.env.ETH_LTK_SUPPORT === "Y") {
      return ltkUtil.sendLtk(db, wallet, callback, willAdd);
    }
    if (wallet.toAddress.length === 0) {
      logger.info("No receiving address supplied; unable to proceed");
      throw new Error("No receiving address supplied");
    }

    await sleep(250); // wait 250ms so that there are only 5 transactions/sec
    logger.info(`eth_utils.send - Transferring ${wallet.amount} ${wallet.type} from ${wallet.senderAddress || wallet.fromAddress} to ${wallet.toAddress}`);
    const web3 = new Web3(WEB3_PROVIDER);

    if(!(await hasEnoughBalance(wallet, web3))) {
      throw new Error("not enough " + wallet.type + " balance");
    }
    
    let gasLimit = web3.toHex(process.env.ETH_GAS_LIMIT);
    let baseGasPrice = wallet.gas || await gasHelper.getAverageGasPrice(db);
    const settings = await settingUtil.getEnvSettings(db);
    var gasPrice = web3.toHex((baseGasPrice * parseFloat(settings.ETH_GAS_PRICE_MULTIPLIER) * 1000000000).toFixed(0));
    logger.debug("eth_utils.send - gas limit: " + web3.toDecimal(gasLimit) + " price: " + web3.toDecimal(gasPrice));
    
    if (wallet.gasFromAmount) {
      const feeAmount = web3.fromWei(new BigNumber(gasPrice).times(gasLimit), "ether");
      wallet.amount = new BigNumber(wallet.amount).minus(feeAmount).toString();
      logger.info(`Deducted gas amount ${feeAmount.toString()}; amount left: ${wallet.amount}`);
    }

    const { data, value, to } = ethSend.getSendDetails(wallet,  wallet.amount, web3);
    let nonce = await ethSend.getWalletNonce(wallet, db, web3);

    let details = {
      to, value, data, gasPrice, nonce,
      gas: gasLimit, chainId: process.env.ETH_CHAIN_ID
    };
    if(process.env.ETH_OTHER_CHAIN_SUPPORT === "Y") {
      await otherEthUtil.modifySendData(web3Eth, details, wallet);
    }
    logger.debug("eth_utils.send - " + JSON.stringify(details));
    // create, sign, and send the transaction
    const txnHash = await ethSend.sendTransactionToWeb3(details, wallet, web3);
    logger.info("eth_utils.send - Transaction sent: " + txnHash);
 
    // we build the transaction details to be stored in the database
    // oct 21 2020 (danie) - saved from address to from for nonce tracking
    let txnDetails = sendHelper.getTransactionDetails(wallet, txnHash, nonce);
    if (willAdd) await sendHelper.insertSendTransaction(db, txnDetails);
    return txnDetails;
  },
  /**
	 * Get the amount of tokens an address holds
	 */
  getTokenBalance: (web3, address) => {
    let tknAddress = (address).substring(2);
    // hash of the "retrieve balance" for tokens
    let contractData = ("0x70a08231000000000000000000000000" + tknAddress);
    return new Promise((resolve, reject)  => {
      web3.eth.call({
        to: process.env.ETH_CONTRACT_ADDRESS,
        data: contractData
      }, (err, tknResult) => {
        if(err) reject(err);
        let tknAmt = getAMTCAmount(parseInt(tknResult, 16));
        logger.debug("eth_utils.getTokenBalance - " + tknAddress + " has " + tknAmt + " tokens");
        resolve(tknAmt);
      });
    });
  },
  /**
	 * Create an ethereum wallet for deposit
	 * Sep 29 2020 (danie) - changed generation to use mnemonic and return private if passed
	 * Oct 21 2020 (danie) - returned public in generate wallet
	 */
  createEthWallet: async (res, db, options) => {
    const { type, returnPrivate } = options;
    let walletType = module.exports.isEthToken(type) ? "AMTC" : type;
    if(process.env.ETH_OTHER_CHAIN_SUPPORT==="Y") {
      return otherEthUtil.createWallet(res, db, {type: walletType});
    }
    const mnemonic = bip39.generateMnemonic();
    const keyPair = ethers.Wallet.fromMnemonic(mnemonic);
    const walletAddress= (await keyPair.getAddress()).toLowerCase();
    let address = {
      type: walletType,
      use: returnPrivate ? "S" : "D",
      address: walletAddress,
      //encrypt the key before storing it in the database
      private: secUtil.encryptKey(keyPair.privateKey),
      phrase: secUtil.encryptKey(mnemonic),
      public: keyPair.publicKey
    };
    logger.info(type + " address generated: " + address.address);

    const success = await createHelper.insertIntoDb(address, db, res);
    if(!success) return;  
    createHelper.sendAddressAndBackUpToFile(address);
    
    createHelper.encryptSecretForResponse(address, keyPair.privateKey, returnPrivate, mnemonic);
    address.type = address.type === "AMTC" ? process.env.ETH_CONTRACT_SYMBOL : type;
    return createHelper.sendReponse(address, res);
  },
  /**
	 * Recover an address given the mnemonic
	 * Sep 29 2020 (danie) - changed generation to use mnemonic and return private if passed
	 */
  recoverAddress: async(mnemonic) => {
    const keyPair = ethers.Wallet.fromMnemonic(mnemonic.trim());
    const address = await keyPair.getAddress();
    return {
      address,
      privateKey: keyPair.privateKey,
      phrase: mnemonic,
      publicKey: keyPair.publicKey
    };
  },
  /**
	 * Create a withdrawal request for Eth or AMTC
	 */
  createEthWithdrawRequest: async (withdrawals, db, after) => {
    try {
      var coinType = module.exports.isEthToken(withdrawals.type) ? "AMTC" : withdrawals.type.toUpperCase();
      logger.info("eth_utils.createEthWithdrawRequest - Creating a " + coinType + " withdraw request");
      var hotAddress = await ethDb.getEthWithdrawWallet(coinType, db);

      const processedList = await dbUtil.processWithdrawRequestList(db, module.exports, after, withdrawals.request);
      if(!processedList) return;
      const totalWithdrawAmount = processedList.totals.totalAmount.toString();
      const approvedStatus = await dbUtil.getWithdrawApprovalStatus(withdrawals, coinType, totalWithdrawAmount);

      let requestDetails = await dbUtil.insertWithdrawRequest(db, processedList, coinType, approvedStatus, hotAddress.address);
      after(requestDetails);
    } catch (err) {
      logger.error("eth_utils.createEthWithdrawRequest - " + err.stack);
      after({ error: "An error occurred while processing the request" });
    }
  },
  isAddress: (address) => {
    const web3 = new Web3(WEB3_PROVIDER);
    return web3.isAddress(address);
  },
  collectDepositWallet: async (db, web3, depositWallet) => {
    let transferSuccess = false;
    if (depositWallet.type === "ETH") {
      transferSuccess = await module.exports.transferToColdEth(db, depositWallet);
    } else if (depositWallet.type === "AMTC") {
      if(new BigNumber(depositWallet.amount).lt(process.env.ETH_GAS_AMTC_MIN || 0)){ 
        logger.debug(`deposit_collection_job - ${depositWallet.address} doesn't have enough tokens`);
      }
      transferSuccess = await module.exports.transferToColdErc(depositWallet, db, web3, depositWallet.amount);	
    }
    return transferSuccess;
  },
  transferToColdEth: async (db, transfer) => {
    const web3 = new Web3(WEB3_PROVIDER);
    var amount = transfer.amount;
    if (process.env.ETH_LTK_SUPPORT=="Y"){
      amount = new BigNumber(transfer.amount).minus(ltkUtil.gasToLianke(ltkUtil.calculateFee(web3.toWei(transfer.amount,"ether"))));
    }
    if (amount <= 0) {
      logger.debug(`Not enough balance in hot wallet ${transfer.address} for transfer`);
      return;
    }
    let list = await dbUtil.getDepositList(db, "eth");
    let wallet = {
      use: "T", type: "ETH", gasFromAmount: true,
      fromAddress: transfer.address,
      key: transfer.private,
    };
    for (const item of list) {
      wallet.toAddress = item.address;
      wallet.amount = amount * item.rate;
      await module.exports.send(db, wallet);
    }
    return true;
  },
  transferToColdErc: async (addr, db, web3, amount = null) => {
    let tokenBalance = (await module.exports.getTokenBalance(web3, addr.address)).toNumber();
    let tokenAmount = (amount && amount <= tokenBalance) ? amount : tokenBalance;
    if(ethSend.doesntMeetMinimumToken(tokenAmount)) {
      logger.debug(`eth_utils.transferToColdErc - ${addr.address} doesn't meet token requirement: ${tokenAmount}`);
      return false;
    }
    const hotWallet = process.env.ETH_HOT_WALLET;
    // if the hot wallet is approved to spend for the deposit address, approve it
    if(!(await ethDb.isApprovedAddress(db, hotWallet, addr.address))) {
      await module.exports.approveAddress(db, web3, hotWallet, addr);
    } else {
      logger.info("eth_utils.transferToColdErc - hot wallet is approved. Sending out deposit of " + addr.address);
      let wallet = {
        fromAddress: process.env.ETH_HOT_WALLET,
        senderAddress: addr.address,
        toAddress: process.env.ETH_COLD_WALLET,
        key: process.env.ETH_HOT_WALLET_SECRET,
        amount: tokenAmount,
        use: "T",
        type: addr.type
      };
      try {
        await module.exports.send(db, wallet);
        return true;
      } catch (err) {
        logger.error("eth_utils.transferToColdErc send error: " + err.stack);
      }
    }
    return false;
  },
  approveAddress: async (db, web3, spender, addr) => {
    const approver = addr.address;
    if(await ethDb.hasPendingApproval(db, spender, approver)) {
      logger.debug(`eth_utils.approveAddress - ${approver} has pending approval`);
      return;
    }
    if(!(await module.exports.hasGasForTransfer(db, web3, approver))) {
      await module.exports.transferGas(db, web3, approver);
    } else {
      logger.debug(`eth_utils.approveAddress - creating approval record for ${approver}`);
      let wallet = {
        fromAddress: approver,
        toAddress: spender,
        key: addr.private,
        use: "APPROVE",
        type: "AMTC"
      };
      await module.exports.send(db, wallet);
    }
  },
  transferGas: async (db, web3, address) => {
    if((await dbUtil.hasPendingIncoming(db, address, "T"))) {
      logger.debug(`eth_utils.transferGas - existing pending incoming txn found for ${address}`);
      return false;
    }

    // get the amount that will be transferred
    const gasWithMultiplier = await module.exports.getGasInEth(db, web3, 0.01);
    const ethBalance = await getEthBalance(web3, address);
    const gasAmtTransfer = gasWithMultiplier.minus(ethBalance).dp(5);
    if(await gasHelper.unableToSendGas(gasAmtTransfer, address, web3, db, gasWithMultiplier)) return;

    logger.debug(`eth_utils.transferGas - transferring gas (${gasAmtTransfer.toString()}) to ${address}`);
    let wallet = {
      use: "T", type: "ETH",
      fromAddress: process.env.ETH_HOT_WALLET,
      key: process.env.ETH_HOT_WALLET_SECRET,
      toAddress: address, 
      amount: gasAmtTransfer.toString(),
    };
    try {
      logger.debug("eth_utils.transferGas - Transferring " + gasAmtTransfer.toString() + " ETH to " + address);
      // send eth to the amtc wallet
      await module.exports.send(db, wallet);
      return false;
    } catch (err) {
      logger.error(err.stack);
    }
  },
  hasGasForTransfer: async (db, web3, address) => {
    let ethBalance = await getEthBalance(web3, address);
    const ethGas = await module.exports.getGasInEth(db, web3);
    return ethBalance.gte(ethGas);
  },
  isEthToken: (type) => {
    const id = type.toUpperCase();
    return id === "AMTC" || id === process.env.ETH_CONTRACT_SYMBOL;
  },
  checkLog: async (web3, walletList, txn, defiCheck = false) => {
    const contractAddr = process.env.ETH_CONTRACT_ADDRESS.toLowerCase();
    const contractNoPrefix = contractAddr.replace("0x", "");
    const DEFI_CONTRACT_LIST = process.env.ETH_DEFI_CONTRACT || " ";
    // check the input if the contract address can be found
    if(defiCheck && !DEFI_CONTRACT_LIST.includes(txn.to) && txn.input.toLowerCase().search(contractNoPrefix) === -1) return;
    const receipt = await web3Lib.getReceipt(web3, txn.hash);
    logger.debug("receipt " +  JSON.stringify(receipt));
    const gas = module.exports.getGasUsedUp(web3, receipt, txn);
    // return non-successful transaction
    if(!receipt || receipt.status !== "0x1") return;
    let txns =[];		
    for(const log of receipt.logs) {
      // last topic would be the receiver of the tokens
      const lastTopic = log.topics.pop();
      if(!lastTopic) continue;
      //[zhen dec 18, 2020- fix incorrect decoding of address
      const toAddress= "0x" + lastTopic.substr(-40);
      // if the address is the contract check the topics
      if(log.address.toLowerCase() === contractAddr && walletList.includes(toAddress)) {
        const amount = getAMTCAmount(log.data).toString();
        txns.push({ amount, toAddress, gas });				
      }
    }
    return txns;
  },
  // Sep 16 2020 (danie) - added function to retrieve ETH given gas prices
  // Sep 23 2020 (danie) - added addtln parameter to increase multiplier
  getGasInEth: async (db, web3, additionalMultiplier = 0) => {
    const settings = await settingUtil.getEnvSettings(db);
    const gasPrice = await getAverageGasPrice(db);
    const multiplier = new BigNumber(settings.ETH_GAS_PRICE_MULTIPLIER).plus(additionalMultiplier); // add 10% 
    const gweiAmt = new BigNumber(gasPrice).times(process.env.ETH_GAS_LIMIT).times(multiplier);
    return new BigNumber(web3.fromWei(gweiAmt.toString(), "gwei")).dp(5, 0);
  },
  getGasUsedUp: (web3, receipt, txn) => {
    return web3.fromWei(txn.gasPrice.times(receipt.gasUsed), "ether").toString();

  }
};

const getEthBalance = async(web3, address) => {
  let weiResult = await web3Lib.getBalance(web3, address);
  return BigNumber(web3.fromWei(weiResult, "ether"));
};

async function hasEnoughBalance(wallet, web3) {
  if(wallet.use === "APPROVE") {
    return true; // no balance check for approve
  }
  
  let balance = 0;
  if(wallet.type === "ETH") {
    balance = await getEthBalance(web3, wallet.fromAddress);
  } else if (wallet.type === "AMTC") {
    balance = await module.exports.getTokenBalance(web3, wallet.senderAddress || wallet.fromAddress);
  }
  return (new BigNumber(balance).gte(wallet.amount));
}
