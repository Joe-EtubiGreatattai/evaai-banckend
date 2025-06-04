// controllers/whatsappController.js
const { sendMessage } = require('./chatController');

exports.handleWebhook = async (req, res) => {
  try {
    const message = req.body.Body;

    const mockReq = {
      user: { id: req.user._id },
      body: { text: message }
    };
    
    const mockRes = {
      status: () => mockRes,
      json: (response) => {
        const aiResponse = response.data.messages.find(m => m.sender === 'assistant').text;
        
        res.set('Content-Type', 'text/xml');
        res.send(`
          <Response>
            <Message>${aiResponse}</Message>
          </Response>
        `);
      }
    };

    await sendMessage(mockReq, mockRes, (err) => {
      if (err) {
        console.error('Error processing WhatsApp message:', err);
        return sendTwimlResponse(res, 'Sorry, I encountered an error processing your message.');
      }
    });

  } catch (error) {
    console.error('Error handling WhatsApp message:', error);
    sendTwimlResponse(res, 'Sorry, I\'m having trouble responding right now. Please try again later.');
  }
};

function sendTwimlResponse(res, message) {
  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Message>${message}</Message>
    </Response>
  `);
}