const functions = require('firebase-functions');
const stripe = require('stripe')(functions.config().keys.webhooks);
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
const axios = require('axios');
const querystring = require('querystring');
const chance = require('chance').Chance();
const PastebinAPI = require('pastebin-js');
const pastebinSecret = functions.config().keys.pastebin;
const pastebin = new PastebinAPI(pastebinSecret);
const endpointSecret = functions.config().keys.signing;
const price = functions.config().keys.price;

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
            price: price,
            adjustable_quantity: {
              enabled: true,
              minimum: 1,
              maximum: 99
            },
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
  return new Promise((resolve, reject) => {
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
    axios(request).catch(err => {
      let res = err.response;
      let params = querystring.parse(res.request.path.split("?").pop());
      if (params.success === 'true') {
        console.log(formattedNumber, 'worked to generate', params["offers[0]"]);
        resolve(params["offers[0]"]);
      } else if (params.error === 'Invalid phone number or configuration') {
        console.log(formattedNumber, 'didn\'t work');
        generatePhoneNumber().then(code => resolve(code));
      } else {
        reject(params);
      }
    });
  });
}

function* generatePhoneNumberIterable(quantity) {
  let iterationCount = 0;
  for (let i = 0; i < quantity; i += 1) {
    iterationCount++;
    yield generatePhoneNumber();
  }
  return iterationCount;
}

function getOrderQuantity(event) {
  return new Promise((resolve, reject) => {
    stripe.checkout.sessions.listLineItems(event.data.object.id, { limit: 100 }, (err, lineItems) => {
      if (err) { reject(err) }
      resolve(lineItems.data[0].quantity);
    });
  });
}

function fulfillOrder(event, quantity, i) {
  const dbCallback = e => {
    if (e) {
      console.error(e);
      console.log(e);
      if (i < 3) {
        fulfillOrder(event, quantity, i + 1);
      } else {
        const message = 'Committing failed 3 times';
        console.error(message);
        console.log(message);
      }
    } else {
      console.log('Code saved successfully');
    }
  }

  // Run this once every generatePhoneNumber promise resolves
  Promise.all(generatePhoneNumberIterable(quantity)).then(async codes => {
    console.log('Going to commit', codes, 'to orders');
    // Generate a pastebin link to host the codes
    if (quantity !== 1) {
      pastebin.createPaste(codes.join('\n'), event.data.object.id, 'text', 1, 'N')
      .then(async data => {
        // Post the codes and its pastebin url
        await admin.database().ref('/orders').child(event.data.object.id).set({
          codes: codes,
          pasteUrl: data,
          created: event.created,
          customerId: event.data.object.customer,
          ...event.data.object.customer_details
        }, e => dbCallback(e));
      }).fail(e => console.error(e));
    } else { // Just post the one code
      await admin.database().ref('/orders').child(event.data.object.id).set({
        code: codes[0],
        created: event.created,
        customerId: event.data.object.customer,
        ...event.data.object.customer_details
      }, e => dbCallback(e));
    }
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
        getOrderQuantity(event)
        .then(quantity => fulfillOrder(event, quantity, 0))
        .catch(e => console.error(e));
        break;
      }
      case 'checkout.session.async_payment_succeeded': {
        if (event.data.object.payment_status === 'paid') {
          getOrderQuantity(event)
          .then(quantity => fulfillOrder(event, quantity, 0))
          .catch(e => console.error(e));
          break;
        }
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
        if (data.hasOwnProperty('code')) {
          return res.status(200).send({ code: data.code });
        } else if (data.hasOwnProperty('pasteUrl')) {
          return res.status(200).send({ pasteUrl: data.pasteUrl });
        }
      } catch (e) { console.error(e) }
    }).catch(e => console.error(e));
  });
});