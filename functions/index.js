const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

exports.sendNotificationOnConversationUpdate = functions.firestore
    .document('chats/{ownerId}/conversations/{mateId}')
    .onUpdate(async (change, context) => {
        try {
            const fcmToken = (await db.doc(`users/${context.params.ownerId}`).get()).data().fcmToken;
            const mateId = context.params.mateId;
            return sendConversationDeleteOrUpdateNotification(fcmToken, mateId);
        } catch (e) {
            console.log(`Conversation update notification error: ${e}`);
            return null;
        }
    })

exports.cleanMessagesOnConversationDeletion = functions.firestore
    .document('chats/{ownerId}/conversations/{mateId}')
    .onDelete(async (snapshot, context) => {
        const ownerId = context.params.ownerId;
        const mateId = context.params.mateId;
        // const deletedConversation = snapshot.data();
        let fcmToken;
        try {
            fcmToken = (await db.doc(`users/${ownerId}`).get()).data().fcmToken;
        } catch (e) {
            // Ignore...
        }

        // Do clean up! Delete messages sent to / received by {ownerId} from {mateId}
        return db.doc(`chats/${ownerId}/messages/${mateId}`).delete()
            .then(() => {
                return db.doc(`chats/${ownerId}/unread-count/${mateId}`).delete();
            }).then(() => {
                return sendConversationDeleteOrUpdateNotification(fcmToken, mateId, Operation.DELETE);
            }).catch(err => {
                console.log('Conversations messages clean up error: ', err);
                return null;
            })
    })

exports.updateConversationsAndSendChatNotification = functions.firestore
    .document('chats/{userId}/messages/{mateId}/messages/{messageId}')
    .onWrite(async (change, context) => {
        const contextUserId = context.params.userId;
        // const contextMateId = context.params.mateId;
        const newMessage = change.after.exists ? change.after.data() : null; // Deletion's probably been done!
        const oldMessage = change.before.data();

        let promise = null
        if (!newMessage && oldMessage) {
            // TODO: Implement OPTIONAL delete from both parties
            // Message was deleted
            const messageId = oldMessage.id;
            const receiverId = oldMessage['receiverId'];
            const senderId = oldMessage['senderId'];
            const mateId = contextUserId === senderId ? receiverId : senderId;
            const mate = await getMate(mateId);

            // Get {contextUserId}'s conversation with {receiverId}
            promise = db.doc(`chats/${contextUserId}/conversations/${mateId}`).get()
                .then(d => {
                    let response = null;
                    if (d.exists) {
                        // Check if conversation's (message)id is same as the old(deleted) message's id
                        if (d.data().id === messageId) {
                            // Deleted message was also a conversation!
                            // Replace it with the latest message between {contextUserId} & {mateId}
                            // Get latest message by {contextUserId} to the {mateId}
                            response = db.collection(`chats/${contextUserId}/messages/${mateId}/messages`)
                                .orderBy('timeSent', 'desc')
                                .limit(1).get();
                        } // Deleted message was not a conversation!
                    }
                    return response;
                }).then(snapshot => {
                    if (!snapshot) return null;
                    // noinspection JSUnresolvedVariable
                    if (snapshot.empty) {
                        console.log(`No more messages found between ${contextUserId} & ${mateId}! Deleting conversation...`);
                        // Delete conversation! Probably all the messages in the conversation were deleted
                        return db.doc(`chats/${contextUserId}/conversations/${mateId}`).delete();
                    }
                    let promises = []
                    // noinspection JSUnresolvedFunction
                    snapshot.forEach(doc => {
                        promises.push(db.doc(`chats/${contextUserId}/conversations/${mateId}`)
                            .set(getMateConversation(doc.data(), mateId, mate)));
                    })
                    console.log(`Update conversations ${promises.length}x`);
                    return Promise.all(promises);
                }).catch(err => {
                    console.log('Error updating conversations after deletion ', err);
                });
        } else {
            // Message was either updated or created
            const receiverId = newMessage['receiverId'];
            const senderId = newMessage['senderId'];

            if (contextUserId === senderId) {
                // conversation will be used to populate a in conversations list
                const senderMate = await getMate(receiverId);
                const receiverMate = await getMate(senderId);
                const unreadCountDocRef = db.doc('chats/' + receiverId + '/unread-count/' + senderId);
                // update sender's conversation(s) with the receiver
                promise = db.doc('chats/' + senderId + '/conversations/' + receiverId)
                    .set(getMateConversation(newMessage, receiverId, senderMate))
                    .then(() => {
                        console.log('Sender {' + senderId + '} conversation added');
                        // Remove un-necessary properties before saving
                        delete newMessage.mateId;
                        delete newMessage.mate;
                        // add message to receiver's messages
                        return db.doc('chats/' + receiverId + '/messages/' + senderId + '/messages/' + newMessage.id)
                            .set(newMessage);
                    }).then(() => {
                        console.log('Receiver {' + receiverId + '} message created');
                        // update message-receiver's conversation(s) with the sender
                        return db.doc('chats/' + receiverId + '/conversations/' + senderId)
                            .set(getMateConversation(newMessage, senderId, receiverMate));
                    }).then(() => {
                        console.log('Receiver {' + receiverId + '} conversation created');
                        // Get receiver's current unread count
                        return unreadCountDocRef.get();
                    }).then(doc => {
                        if (oldMessage) {
                            // Message was update, no need of updating count
                            if (oldMessage.id === newMessage.id) return null;
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
                            console.log(`Error: ${err}`);
                        }
                    );
            } else {
                // DsID: Data Sender ID; CsID: Context Sender ID
                console.log('DsID not same as CsId! DsID: {' + senderId + '} CsID: {' + contextUserId + '}')
            }
        }
        return promise
    })

async function getMate(mateId) {
    return (await db.doc(`users/${mateId}`).get()).data();
}

function getMateConversation(message, mateId, mate) {
    try {
        // noinspection JSUnresolvedVariable
        delete mate.fcmToken;
    } catch (e) {
        // Ignore
    }
    const conversation = message;
    conversation.mateId = mateId;
    conversation.mate = mate;
    return conversation;
}

function sendConversationDeleteOrUpdateNotification(receiverTokens, mateId, operation = Operation.UPDATE) {
    return admin.messaging().sendToDevice(receiverTokens, {
        data: {
            mateId: mateId,
            operation: operation
        }
    }).then(response => {
        return console.log(`Conversation ${operation} message sent: `, response);
    }).catch(err => {
        console.log(`Failed to send conversation ${operation} notification: `, err);
    });
}

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
        ttl: 30 * 24 * 60 * 60,
        priority: 'high'
    }).then(response => {
        return console.log('FCM message sent: ', response);
    }).catch(err => {
        console.log('Failed to send notification: ', err);
    });
}

const Operation = {
    DELETE: 'DELETE',
    UPDATE: 'UPDATE'
}