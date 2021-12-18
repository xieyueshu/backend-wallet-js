var winston = require('winston');
require('winston-daily-rotate-file');

var options = {
  console: {
    level: (process.env.NODE_ENV === "development") ? 'debug' : 'info',
    handleExceptions: true,
    json: false,
    colorize: true
  },
  dailyFile: {
	  level: 'debug',
    filename: 'logs/application-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: '20m'
  },
};


// create a logger for console and for daily files
var logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
      }),
      winston.format.printf(info => {
          return `${info.timestamp} ${info.level}: ${info.message}`;
    })
  ),
  transports: [
    new winston.transports.Console(options.console),
    new (winston.transports.DailyRotateFile)(options.dailyFile)
  ],
  exitOnError: false, // do not exit on handled exceptions
});

logger.stream = {
  write: function(message) {
    logger.info(message);
  },
};

module.exports = logger;