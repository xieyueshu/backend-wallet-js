const nodemailer = require("nodemailer");

const logger = require("../../config/winston");

let lastEmailTime = null;
let transporterOpt = {
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
};

// check if there is a service or host provided in the config file
if (process.env.MAIL_SERVICE) {
  transporterOpt.service = process.env.MAIL_SERVICE;
} else {
  transporterOpt.host = process.env.MAIL_HOST;
}

// transporter object using the options
let transporter = null;
if(process.env.MAIL_SERVICE || process.env.MAIL_HOST) {
  transporter = nodemailer.createTransport(transporterOpt);
} 

const sendMail = (to, subject, text, html) => {
  let mailOptions = {
    from: process.env.MAIL_USER,
    to,
    subject,
    text,
    html
  };
  logger.debug("Sent mail: " + JSON.stringify(mailOptions));
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return logger.error(error);
    }
    logger.debug("Message sent: " + info.messageId);
  });

};

module.exports = {
  /**
     * sends mail
     */
  send: (to, subject, text, html) => {
    if(!transporter) return;
    sendMail(to, subject, text, html);
  },
  /**
     * Sends mail to configured email addresses containing the newly generated address 
     */
  sendAddressCopy: async (address) => {
    if(!transporter) return;
    let mailList = process.env.ADDRESS_MAIL_SEND.split(",");
    for (let i = 0; i < mailList.length; i++) {
      try {
        logger.debug("Sending " + address.address + " copy to: " + mailList[i]);
        sendMail(mailList[i], "Generated Wallet Address", JSON.stringify(address), JSON.stringify(address));
      } catch(e) {
        logger.warn(`Error sending ${address.address} to ${mailList[i]}: ${e.stack}`);
      }
    }
  },
  /**
     * Sends mail to the email that will be notified on not enough balance 
     */
  sendWithdrawBalance: async (amountReq, balance, address, coinName = "AMTC") => {
    if(!transporter) return;
    // only one email per hour
    if(lastEmailTime || new Date() - lastEmailTime < 3600000) return;
    let mailList = process.env.WITHDRAW_MAIL_SEND.split(",");
    let mailContent =
        `There is not enough funds in order to complete the remaining withdrawals.<br />
         The current balance is ${balance} ${coinName} while the pending amount is ${amountReq} ${coinName}. <br />
         Please deposit <b>${amountReq - balance} ${coinName}</b> to ${address} in order to complete the pending withdrawals in the system.`;
    for (let i = 0; i < mailList.length; i++) {
      logger.debug("Sending withdraw balance notif to: " + mailList[i]);
      sendMail(mailList[i], "Withdrawal funding requirement", mailContent, mailContent);
    }
    lastEmailTime = new Date();
  }

};