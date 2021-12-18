// Sep 9 2020 (danie) - added TRX block number
// Sep 10 2020 (danie) - added editSettings permission
module.exports = {
  base: [
    {"name":"lastBlkNum", "value": 100000000}, 
    {"name":"lastBlkNumDnab", "value": 100000000}, 
    {"name":"lastBlkNumAtm", "value": 100000000}, 
    {"name":"lastBlkBtc", "value": 100000000}, 
    {"name":"lastBlkTrx", "value": 100000000}, 
    {"name":"lastBlkFil", "value": 100000000}, 
    {"name": "ethGasPrice", "value": 50}, 
    {"name": "exchangeRates", "USD": {}, "CNY": {}, "PHP": {}, "lastUpdated":""},
    { "name": "settings",
      "WITHDRAW_ETH_APPROVAL" : "-1",
      "WITHDRAW_AMTC_APPROVAL" : "-1",
      "WITHDRAW_TRX_APPROVAL" : "-1",
      "WITHDRAW_TRC20_APPROVAL" : "-1",
      "WITHDRAW_FIL_APPROVAL" : "-1",
      "WITHDRAW_EOS_APPROVAL" : "-1",
      "WITHDRAW_BTC_APPROVAL" : "-1",
    }
  ],

  permission: [
    { "code" : "transferGas", "label" : "Trigger transfer of ETH for gas to deposit wallets" },
    { "code" : "transferCold", "label" : "Trigger transfer of tokens/ETH from deposit wallets to cold wallet" },
    { "code" : "updateRates", "label" : "Update coin rates manually" },
    { "code" : "editSettings", "label" : "Update System settings" },
    { "code" : "viewWithdraw", "label" : "View withdrawal records" },
    { "code" : "viewDeposit", "label" : "View deposit records" },
    { "code" : "viewSent", "label" : "View sendfrom records" },
    { "code" : "viewUsers", "label" : "View user list" },
    { "code" : "viewWithdrawRequest", "label" : "View withdrawal requests" }
  ]
}