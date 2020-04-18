let _ = require("lodash");
let fs = require("fs");
let path = require("path");
let {StringDecoder} = require("string_decoder");
let express = require("express");
let WebSocket = require("ws");
let app = express();
const superagent = require('superagent');

let {WebSocketClient} = require("./client/js/WebSocketClient.js");
let {BootstrapStep}   = require("./client/js/BootstrapStep.js");

const config = require('./config');

// Spotify auth
const base64Auth = Buffer.from(config.spotifyClientId + ':' + config.spotifySecretKey).toString('base64');
const redirect_uri = "http://localhost:2018/spotify/callback";
let access_token;
let refresh_token;



let wss = new WebSocket.Server({ port: 2019 });
console.log("whatsapp-web-reveng API server listening on port 2019");

let backendInfo = {
    url: "ws://localhost:2020",
    timeout: 10000
};

wss.on("connection", function(clientWebsocketRaw, req) {
    let backendWebsocket = new WebSocketClient();
    let clientWebsocket = new WebSocketClient().initializeFromRaw(clientWebsocketRaw, "api2client", {getOnMessageData: msg => new StringDecoder("utf-8").write(msg.data)});
    clientWebsocket.send({ type: "connected" });
    //clientWebsocket.onClose(() => backendWebsocket.disconnect());

    clientWebsocket.waitForMessage({
        condition: obj => obj.from == "client"  &&  obj.type == "call"  &&  obj.command == "api-connectBackend",
        keepWhenHit: true
    }).then(clientCallRequest => {
        if(backendWebsocket.isOpen)
            return;
        new BootstrapStep({
            websocket: backendWebsocket,
            actor: websocket => {
                websocket.initialize(backendInfo.url, "api2backend", {func: WebSocket, args: [{ perMessageDeflate: false }], getOnMessageData: msg => new StringDecoder("utf-8").write(msg.data)});
                websocket.onClose(() => {
                    clientWebsocket.send({ type: "resource_gone", resource: "backend" });
                });
            },
            request: {
                type: "waitForMessage",
                condition: obj => obj.from == "backend"  &&  obj.type == "connected"
            }
        }).run(backendInfo.timeout).then(backendResponse => {
            clientCallRequest.respond({ type: "resource_connected", resource: "backend" });
        }).catch(reason => {
            clientCallRequest.respond({ type: "error", reason: reason });
        });
    }).run();

    clientWebsocket.waitForMessage({
        condition: obj => obj.from == "client"  &&  obj.type == "call"  &&  obj.command == "backend-connectWhatsApp",
        keepWhenHit: true
    }).then(clientCallRequest => {
        if(!backendWebsocket.isOpen) {
            clientCallRequest.respond({ type: "error", reason: "No backend connected." });
            return;
        }
        new BootstrapStep({
            websocket: backendWebsocket,
            request: {
                type: "call",
                callArgs: { command: "backend-connectWhatsApp" },
                successCondition: obj => obj.type == "resource_connected"  &&  obj.resource == "whatsapp"  &&  obj.resource_instance_id
            }
        }).run(backendInfo.timeout).then(backendResponse => {
            backendWebsocket.activeWhatsAppInstanceId = backendResponse.data.resource_instance_id;
            backendWebsocket.waitForMessage({
                condition: obj => obj.type == "resource_gone"  &&  obj.resource == "whatsapp",
                keepWhenHit: false
            }).then(() => {
                delete backendWebsocket.activeWhatsAppInstanceId;
                clientWebsocket.send({ type: "resource_gone", resource: "whatsapp" });
            });
            clientCallRequest.respond({ type: "resource_connected", resource: "whatsapp" });
        }).catch(reason => {
            clientCallRequest.respond({ type: "error", reason: reason });
        });
    }).run();

    clientWebsocket.waitForMessage({
        condition: obj => obj.from == "client"  &&  obj.type == "call"  &&  obj.command == "backend-disconnectWhatsApp",
        keepWhenHit: true
    }).then(clientCallRequest => {
        if(!backendWebsocket.isOpen) {
            clientCallRequest.respond({ type: "error", reason: "No backend connected." });
            return;
        }
        new BootstrapStep({
            websocket: backendWebsocket,
            request: {
                type: "call",
                callArgs: { command: "backend-disconnectWhatsApp", whatsapp_instance_id: backendWebsocket.activeWhatsAppInstanceId },
                successCondition: obj => obj.type == "resource_disconnected"  &&  obj.resource == "whatsapp"  &&  obj.resource_instance_id == backendWebsocket.activeWhatsAppInstanceId
            }
        }).run(backendInfo.timeout).then(backendResponse => {
            clientCallRequest.respond({ type: "resource_disconnected", resource: "whatsapp" });
        }).catch(reason => {
            clientCallRequest.respond({ type: "error", reason: reason });
        });
    }).run();

    clientWebsocket.waitForMessage({
        condition: obj => obj.from == "client"  &&  obj.type == "call"  &&  obj.command == "backend-generateQRCode",
        keepWhenHit: true
    }).then(clientCallRequest => {
        if(!backendWebsocket.isOpen) {
            clientCallRequest.respond({ type: "error", reason: "No backend connected." });
            return;
        }
        new BootstrapStep({
            websocket: backendWebsocket,
            request: {
                type: "call",
                callArgs: { command: "backend-generateQRCode", whatsapp_instance_id: backendWebsocket.activeWhatsAppInstanceId },
                successCondition: obj => obj.from == "backend"  &&  obj.type == "generated_qr_code"  &&  obj.image  &&  obj.content
            }
        }).run(backendInfo.timeout).then(backendResponse => {
            clientCallRequest.respond({ type: "generated_qr_code", image: backendResponse.data.image })

            backendWebsocket.waitForMessage({
                condition: obj => obj.type == "whatsapp_message_received"  &&  obj.message  &&  obj.message_type  &&  obj.timestamp  &&  obj.resource_instance_id == backendWebsocket.activeWhatsAppInstanceId,
                keepWhenHit: true
            }).then(whatsAppMessage => {
                let d = whatsAppMessage.data;

                try {
                    let url = d.message[2][0]["message"]["extendedTextMessage"]["canonicalUrl"];
                    console.log(url);
                    if (url.startsWith('https://open.spotify.com/track')) 
                    {
                        superagent
                            .post('https://api.spotify.com/v1/me/player/queue')
                            .type('form')
                            .accept('json')
                            .set('Authorization', 'Bearer ' + access_token)
                            .query({ uri: url })
                            .then(res => {
                                console.log(res.status);
                             })
                             .catch(err => {
                                console.log(err.status);
                             });
                    }
                }
                catch {

                }

                clientWebsocket.send({ type: "whatsapp_message_received", message: d.message, message_type: d.message_type, timestamp: d.timestamp });
            }).run();
        }).catch(reason => {
            clientCallRequest.respond({ type: "error", reason: reason });
        })
    }).run();
})




app.use(express.static("client"));

app.get('/', function(req, res) {
    var scopes = 'user-read-playback-state user-modify-playback-state user-read-currently-playing streaming app-remote-control';
    res.redirect('https://accounts.spotify.com/authorize' +
        '?response_type=code' +
        '&client_id=' + config.spotifyClientId +
        (scopes ? '&scope=' + encodeURIComponent(scopes) : '') +
        '&redirect_uri=' + encodeURIComponent(redirect_uri));
});

app.get("/spotify/callback", function(req, res) {
    const code = req.query.code;

    superagent
        .post('https://accounts.spotify.com/api/token')
        .type('form')
        .accept('json')
        .set('Authorization', 'Basic ' + base64Auth)
        .send({ grant_type: 'authorization_code'})
        .send({ code: code})
        .send({ redirect_uri: redirect_uri})
        .end((err, res) => {
            if (err) {
                res.end(`<p>Something went wrong, <a href="/">please retry</a>.</p>`);
            }

            access_token = res.body["access_token"];
            refresh_token = res.body["refresh_token"];
            console.log(res.body);
        });

    res.redirect("/client.html");
});
    

app.listen(2018, function() {
    console.log("whatsapp-web-reveng HTTP server listening on port 2018");
});
