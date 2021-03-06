var kafka = require("kafka-node");
var axios = require("axios");

var getToken = require('./auth.js')
var config = require('./config');

function getRandom() {
  return Math.floor(Math.random() * 10000);
}

const KAFKA_DEFAULTS = {
  "kafkaHost": config.kafka_address,
  "sessionTimeout": "15000",
  "groupId": 'iotagent-' + getRandom()
}

const DATA_BROKER_DEFAULT = "http://" + config.data_broker_address;


class TopicManager {
  constructor() {
    this.topics = {};
  }

  getTopic(subject, tenant, broker, global) {
    const key = tenant + ':' + subject;
    
    if (this.topics.hasOwnProperty(key)) {
      return Promise.resolve(this.topics[key]);
    }

    const querystring = global ? "?global=true" : "";
    const url = `${broker}/topic/${subject + querystring}`

    return axios({
      url,
      method: 'get',
      headers: { authorization: `Bearer ${getToken(tenant)}`}
    })
    .then((response) => {
      this.topics[key] = response.data.topic;
      
      return response.data.topic
    });
  }
}

var tm = new TopicManager();

class Consumer {
  /**
   * [constructor description]
   * @param {[string]} tenant        Tenant which devices will be monitored
   * @param {[string]} brokerManager If omitted takes the default "http://data-broker:80"
   * @param {[string]} subject       If omitted takes the default "dojot.device-manager.device"
   */
  constructor(tenant, subject, global, brokerManager){
    this.tenant = tenant;
    this.subject = subject;
    this.global = global || false;
    this.brokerManager = brokerManager || DATA_BROKER_DEFAULT;
    this.callbacks = [];

    tm.getTopic(this.subject, this.tenant, this.brokerManager, this.global).then((topic) => {
      // TODO kafka params should come from config
      let config = KAFKA_DEFAULTS;
      // config.groupId = uuid();
      this.consumer = new kafka.ConsumerGroup(KAFKA_DEFAULTS, topic);
      let cb = this.callbacks.pop();
      while(cb) {
        this.on(cb.event, cb.callback);
        cb = this.callbacks.pop();
      }
      console.log('[iota:kafka] Created consumer (%s)[%s : %s]', config.groupId, this.subject, topic)

    }).catch((error) => {
      console.error("[iota:kafka] Failed to acquire topic to subscribe from (device events)\n", error);
      process.exit(1);
    })
  }

  on(event, callback) {
    if (this.consumer) {
      this.consumer.on(event, callback);
    } else {
      // consumer was not ready yet when call was issued
      this.callbacks.push({'event': event, 'callback': callback});
    }
  }
}

class Producer {
  constructor(brokerManager) {
    this.topics = {};

    this.brokerManager = brokerManager || DATA_BROKER_DEFAULT;

    this.isReady = false;
    this.initProducer();
  }

  initProducer(callback) {
    let client = new kafka.KafkaClient(KAFKA_DEFAULTS);
    this.producer = new kafka.Producer(client, { requireAcks: 1 });

    this.producer.on('ready', () => {
      console.log("[iota:kafka] Producer ready");
      this.isReady = true;
      if (callback) {
        callback();
      }
    });

    let scheduled = null;
    this.producer.on("error", (e) => {
      if (scheduled) {
        console.log("[iota:kafka] An operation was already scheduled. No need to do it again.");
        return;
      }

      this.producer.close();
      console.error("[iota:kafka] Producer error: ", e);
      console.log("[iota:kafka] Will attempt to reconnect in a few seconds.");
      scheduled = setTimeout(() => {
          this.initDataProducer();
      }, 10000);
    });
  }

  /**
   * Sends an event to a given subject of a tenant
   * @param  {[type]} tenant    Tenant to whom event is concerned
   * @param  {[type]} subject   Subject which event belongs to
   * @param  {[type]} eventData Event to be sent
   */
  sendEvent(tenant, subject, eventData) {
    if (this.isReady == false) {
      console.error('[iota:kafka] Producer is not ready yet');
      return;
    }

    tm.getTopic(subject, tenant, this.brokerManager, false).then((topic) => {
      let message = {
        "topic": topic,
        "messages": [JSON.stringify(eventData)]
      };

      this.producer.send([message], (err) => {
        if (err) {
          console.error("[iota:kafka] Failed to publish data", err);
          this.producer.close();
          this.initProducer();
        }
      });
    }).catch((error) => {
      console.error("[iota] Failed to ascertain topic for event", error)
    })
  }
}

module.exports = {'Consumer': Consumer, 'Producer': Producer};
