const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

exports.updateConversationsAndUnreadCounts = functions.firestore
    .document('chats/{userId}/messages/{mateId}/messages/{messageId}')
    .onWrite((change, context) => {
        const contextUserId = context.params.userId;
        const contextMateId = context.params.mateId;
        const newMessage = change.after.exists ? change.after.data() : null; // Deletion's probably been done!
        const oldMessage = change.before.data();

        console.log('Delete Request: ' + !newMessage); // TODO: delete...
        let promise = null
        if (!newMessage && oldMessage) {
            // TODO: Implement OPTIONAL delete from both parties
            // Message was deleted
            const messageId = oldMessage.id;
            const receiverId = oldMessage['receiverId'];
            const senderId = oldMessage['senderId'];
            const mateId = contextUserId === senderId ? receiverId : senderId
            console.log('Context MateID: {' + contextMateId + '} MateID: {' + mateId + '} SenderID: {' + senderId + '}'); // TODO: Delete...
            // Get {contextUserId}'s conversation with {receiverId}
            promise = db.doc('chats/' + contextUserId + '/conversations/' + mateId).get()
                .then(d => {
                    let response = null;
                    if (d.exists) {
                        // Check if conversation's (message)id is same as the old(deleted) message's id
                        if (d.data().id === messageId) {
                            // Deleted message was also a conversation!
                            // Replace it with the latest message between {contextUserId} & {mateId}
                            // Get latest message by {contextUserId} to the {mateId}
                            response = db.collection('chats/' + contextUserId + '/messages/' + senderId + '/messages/')
                                .orderBy('timeSent', 'desc')
                                .limit(1).get();
                        } // Deleted message was not a conversation!
                    }
                    return response;
                }).then(snapshot => {
                    if (!snapshot) return null;
                    let promises = []
                    // noinspection JSUnresolvedFunction
                    snapshot.forEach(doc => {
                        promises.push(db.doc('chats/' + contextUserId + '/conversations/' + mateId).set(doc.data()));
                    })
                    return Promise.all(promises);
                }).catch(err => {
                    console.log('Error updating conversations after deletion ', err)
                });
        } else {
            // Message was either updated or created
            const receiverId = newMessage['receiverId'];
            const senderId = newMessage['senderId'];

            if (contextUserId === senderId) {
                // update message sender's conversations
                const unreadCountDocRef = db.doc('chats/' + receiverId + '/unread-count/' + senderId);
                promise = db.doc('chats/' + senderId + '/conversations/' + receiverId).set(newMessage)
                    .then(() => {
                        console.log('Sender {' + senderId + '} conversation added');
                        // add message to receiver's messages
                        return db.doc('chats/' + receiverId + '/messages/' + senderId + '/messages/' + newMessage.id)
                            .set(newMessage);
                    }).then(() => {
                        console.log('Receiver {' + receiverId + '} message created');
                        // update message receiver's conversations
                        return db.doc('chats/' + receiverId + '/conversations/' + senderId)
                            .set(newMessage);
                    }).then(() => {
                        // Get receiver's current unread count
                        return unreadCountDocRef.get();
                    }).then(doc => {
                        if (oldMessage) {
                            // Probably an update
                            if (oldMessage.id === newMessage.id) return null; // Message was update, no need of updating count
                        }
                        let unreadCount = 1;
                        // noinspection JSUnresolvedVariable
                        if (doc.exists) unreadCount += doc.data()['count'];
                        // update message receiver's unread count
                        return unreadCountDocRef.set({'count': unreadCount});
                    }).then(() => {
                        // Initiate notification sending to the message receiver
                        // Fetch details of the receiver(most required is his/her fcmToken)
                        return db.doc('users/' + receiverId).get();
                    }).then(doc => {
                        if (doc.exists) {
                            const fcmToken = doc.data()['fcmToken']
                            if (fcmToken) return sendNotification(senderId, fcmToken, newMessage);
                        }
                        return null;
                    }).catch(err => {
                            console.log('Error: ' + err);
                        }
                    );
            } else {
                console.log('DsID not same as CsId! DsID: {' + senderId + '} CsID: {' + contextUserId + '}')
            }
        }
        return promise
    })

function sendNotification(senderId, receiverTokens, messageData) {
    return admin.messaging().sendToDevice(receiverTokens, {
        data: {
            title: senderId.toString(), // what will be used to fetch the senders name from your contact list
            body: messageData.body.toString(),
            payload: JSON.stringify({
                senderId: senderId.toString(),
                messageId: messageData.id.toString()
            }) // Will be used to initiate a message fetch upon notification reception at the client side
        }
    }, {
        ttl: 24 * 60 * 60,
        priority: 'high'
    }).then(response => {
        return console.log('FCM message sent: ', response);
    }).catch(err => {
        console.log('Failed to send notification: ', err);
    });
}