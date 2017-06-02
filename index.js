'use strict'

let aws = require('aws-sdk');
let cwl = new aws.CloudWatchLogs();
let sns = new aws.SNS();
let ses = new aws.SES();

const FROM_MAIL = 'rafal@spinify.com'
const NOTIFY_MAILS = ['rafal@spinify.com', 'errors@spinify.com']
const NOTIFICATION_ARN = 'arn:aws:sns:us-west-2:378652543277:email-on-warn'
const REGION = 'us-west-2'
const SINGLE_ERROR_LENGTH = 255

exports.handler = function (event, context, callback) {
  console.dir(JSON.stringify(event, null, 2))
  let notificationContent = {}
  let message = {}
  let metricFilter = {}

  Promise.resolve()
    .then(() => {
      message = JSON.parse(event.Records[0].Sns.Message)

      return {
        metricName: message.Trigger.MetricName,
        metricNamespace: message.Trigger.Namespace
      }
    })
    .then(requestParams => {
      return new Promise((resolve, reject) => {
        cwl.describeMetricFilters(requestParams, function (err, data) {
          if (err) {
            reject(err)
          } else {
            console.log('Metric Filter data is:', data);
            resolve(data)
          }
        })
      })
    })
    .then(metricFilterData => {
      metricFilter = metricFilterData.metricFilters[0]

      return getLogsAndSendNotification(message, metricFilterData)
    })
    .then(logEvents => {
      notificationContent = generateNotificationContent(logEvents, message, metricFilter.logGroupName)
    })
    .then(() => {
      console.log('Send an e-mail', notificationContent)

      return new Promise((resolve, reject) => {
        ses.sendEmail({
          Destination: {
            ToAddresses: NOTIFY_MAILS
          },
          Message: {
            Body: {
              Html: {
                Data: notificationContent.Message
              }
            },
            Subject: {
              Data: notificationContent.Subject
            }
          },
          Source: FROM_MAIL
        }, (err, data) => {
          console.log('MAIL_RESULT', err, data)

          if (err) {
            reject(err)
          } else {
            console.log("===EMAIL SENT===");
            resolve(data)
          }
        })
      })
    })
    .then(() => {
      console.log('Success')
      callback(null, 'Success sending notifications')
    })
    .catch(err => {
      console.log('Error', err)
      callback(err)
    })
};

function getLogsAndSendNotification (message, metricFilterData) {
  let timestamp = Date.parse(message.StateChangeTime);
  let offset = 2 * message.Trigger.Period * message.Trigger.EvaluationPeriods * 1000; // double the offset
  let metricFilter = metricFilterData.metricFilters[0];
  let parameters = {
    'logGroupName': metricFilter.logGroupName,
    'filterPattern': metricFilter.filterPattern ? metricFilter.filterPattern : "",
    'startTime': timestamp - offset,
    'endTime': timestamp
  }

  return filterLogEvents(parameters)
}

function filterLogEvents (parameters) {
  console.log('Filter log events for parameters', parameters)

  let events = []
  return new Promise((resolve, reject) => {
    cwl.filterLogEvents(parameters, function (err, data) {
      if (err) {
        reject(err)
      } else {
        console.log('FilterLogEvents response', data)
        events = data.events

        return Promise.resolve()
          .then(() => {
            if (data.nextToken && data.nextToken.length > 0) {
              console.log('NextToken available', data.nextToken)
              parameters.nextToken = data.nextToken

              return filterLogEvents(parameters)
                .then(childEvents => {
                  console.log('ChildEvents', childEvents)
                  return events.concat(childEvents)
                })
            }

            return events
          })
          .then(events => {
            resolve(events)
          })
      }
    });
  })
}

function generateNotificationContent (events, message, logGroupName) {
  console.log('Events are:', events);
  let logData = '<br/>Logs:<br/><br />';
  for (let i in events) {
    logData += '<b>Message:</b>' + JSON.stringify(events[i]['message']).substr(0, SINGLE_ERROR_LENGTH) + '<br />';
    logData += '<a href="https://console.aws.amazon.com/cloudwatch/home?region=' + REGION + '#logEventViewer:group=' + logGroupName + ';stream=' + events[i]['logStreamName'] + ';reftime=' + events[i]['timestamp'] + ';refid=' + events[i]['eventId'] + '">Click to open logs in CloudWatch console</a><br />'
    logData += '<br />'
  }

  let date = new Date(message.StateChangeTime);
  let text = 'Alarm Name: ' + '<b>' + message.AlarmName + '</b><br/>' +
    'Account ID: ' + message.AWSAccountId + '<br/>' +
    'Region: ' + message.Region + '<br/>' +
    'Alarm Time: ' + date.toString() + '<br/>' +
    logData;
  text += '<br />Best regards,<br />Yours Log Provider'

  return {
    Message: text,
    Subject: 'PRD/STG: Details for Alarm - ' + message.AlarmName,
    TopicArn: NOTIFICATION_ARN
  };
}