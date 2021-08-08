const functions = require('firebase-functions');
const stripe = require('stripe')(functions.config().keys.webhooks);
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
const axios = require('axios');
const querystring = require('querystring');
const chance = require('chance').Chance();
const endpointSecret = functions.config().keys.signing;

admin.initializeApp();

exports.checkout_sessions = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method === 'POST') {
      try {
        // Create Checkout Sessions from body params.
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          line_items: [{
            price: 'price_1JM2QLCAIbay177QDnjie75G',
            quantity: 1,
          }],
          success_url: `${req.headers.origin}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${req.headers.origin}/?canceled=true`,
        });
        res.redirect(303, session.url);
      } catch (err) {
        res.status(err.statusCode || 500).json(err.message);
      }
    } else {
      res.setHeader('Allow', 'POST');
      res.status(405).end('Method Not Allowed');
    }
  });
});

function generatePhoneNumber() {
  const unformattedNumber = chance.phone({ formatted: false });
  const formattedNumber = unformattedNumber.substr(0,3) +
    '-' + unformattedNumber.substr(3,3) + '-' + unformattedNumber.substr(6);
  const request = {
    url: 'https://api.andpizza.com/handlers/phone-offers/gxresolve',
    method: 'POST',
    data: 'phone=' + formattedNumber,
    headers: {
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "max-age=0",
      "content-type": "application/x-www-form-urlencoded",
      "sec-ch-ua": "\"Google Chrome\";v=\"89\", \"Chromium\";v=\"89\", \";Not A Brand\";v=\"99\"",
      "sec-ch-ua-mobile": "?0",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-site",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1"
    }
  };
  return axios(request).catch(err => {
    let res = err.response;
    let params = querystring.parse(res.request.path.split("?").pop());
    if (params.success === 'true') {
      return(params["offers[0]"]);
    } else if (params.error === 'Invalid phone number or configuration') {
      return generatePhoneNumber();
    } else {
      return new Promise((resolve, reject) => reject(params));
    }
  })
}

function fulfillOrder(event) {
  generatePhoneNumber().then(async code => {
    console.log("Fulfilling order:", event.data.object.id, 'with code:', code);
    await admin.database().ref('/orders').set({
      [event.data.object.id]: {
        code: code,
        created: event.created,
        customerId: event.data.object.customer,
        ...event.data.object.customer_details
      }
    });
  }).catch(e => console.error(e));
}

// realtime database and webhook endpoint in stripe on checkout.session.completed to associate checkout.id with the code
exports.generateCode = functions.https.onRequest((req, res) => {
  // TODO: remove cors wrapper
  cors(req, res, () => {

    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
      res.sendStatus(200);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        if (event.data.object.payment_status === 'paid') {
          fulfillOrder(event);
        }
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        fulfillOrder(event);
        break;
      }
      default: {
        break;
      }
    }
  });
});

// Get code from database to respond to polling
exports.getCode = functions.https.onRequest((req, res) => {
  cors(req, res, () => {
    console.log("key:", req.header('Authorization'));
    admin.database().ref('orders')
    .child(req.header('Authorization'))
    .once('value', snapshot => {
      try {
        const data = snapshot.val();
        console.log(data);
        return res.status(200).send({ code: data.code });
      } catch (e) { console.error('Malformed Database') }
    });
  });
});