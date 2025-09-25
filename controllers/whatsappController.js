const { sendMessage } = require('./chatController');
const User = require('../models/User');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { MessageMedia } = require('whatsapp-web.js');
const { generateInvoicePDF } = require('./../services/actionHandlers/invoiceActions');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function handleWhatsAppMessage(msg) {
  console.log('📩 New incoming WhatsApp message:', {
    from: msg.from,
    body: msg.body,
    hasMedia: msg.hasMedia,
  });

  try {
    const senderId = msg.from;
    const rawPhone = senderId.split('@')[0];

    // Normalize phone number to match the User schema format
    const normalizedPhone = String(rawPhone).replace(/\D/g, '');
    
    // Check if user exists in database (only respond to registered users)
    let user = await User.findOne({ phoneNumber: normalizedPhone });

    if (!user) {
      console.log(`❌ Ignoring message from unregistered user: ${normalizedPhone}`);
      return; // Silently exit without responding
    }

    console.log(`✅ Registered user found: ${user.fullName} (${user.phoneNumber})`);

    let messageText = msg.body || '';
    let userUsedVoiceNote = false;

    if (msg.hasMedia) {
      console.log('📷 Media message detected. Attempting to download...');
      const media = await msg.downloadMedia();
      if (!media) return msg.reply("Couldn't download the media, please try again.");

      const rawExt = media.mimetype.split('/')[1];
      const ext = rawExt.split(';')[0];
      const filename = `media_${Date.now()}.${ext}`;
      const downloadsDir = path.join(__dirname, 'downloads');

      if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

      const filePath = path.join(downloadsDir, filename);
      fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
      console.log(`✅ Media saved: ${filePath}`);

      const isImage = media.mimetype.startsWith('image');
      const isAudio = media.mimetype.startsWith('audio');

      if (isImage) {
        console.log('🖼️ Processing image with AI...');
        try {
          const caption = msg.body || "Describe this image";

          const gptResponse = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: "system",
                content: "You are an AI assistant that describes images in detail. Provide a comprehensive description of what you see in the image."
              },
              {
                role: "user",
                content: [
                  { type: "text", text: `Please describe this image in detail. User's caption/question: "${caption}"` },
                  { type: "image_url", image_url: { url: `data:${media.mimetype};base64,${media.data}` } }
                ],
              },
            ],
            max_tokens: 500,
          });

          const imageDescription = gptResponse.choices[0].message.content.trim();
          console.log('🖼️ Image description generated:', imageDescription);
          messageText = `Image: ${imageDescription}`;
          fs.unlinkSync(filePath);

        } catch (error) {
          console.error('❌ Error processing image:', error);
          messageText = `Image: Unable to process the image.`;
        }

      } else if (isAudio) {
        userUsedVoiceNote = true;
        console.log('🎙️ Transcribing audio...');
        try {
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-1",
          });

          const transcribedText = transcription.text.trim();
          console.log('📝 Audio transcription:', transcribedText);
          messageText = transcribedText;
          fs.unlinkSync(filePath);

        } catch (error) {
          console.error('❌ Audio transcription failed:', error);
          messageText = `Voice message: Unable to transcribe the audio.`;
        }

      } else {
        console.log(`📎 Unsupported media type: ${media.mimetype}`);
        messageText = `Unsupported media type: ${media.mimetype}`;
        fs.unlinkSync(filePath);
      }
    }

    if (!messageText.trim()) {
      return msg.reply('Please send a valid text or voice message.');
    }

    console.log('🧠 Forwarding message to AI:', messageText);

    const mockReq = {
      user: { id: user._id },
      body: { text: messageText }
    };

    const mockRes = {
      status: () => mockRes,
      json: async (response) => {
        try {
          const aiResponse = response.data.messages.find(m => m.sender === 'assistant')?.text || 'No response generated.';
          console.log('🤖 AI response:', aiResponse);

          const createdInvoice = response.data?.actionResult?.data;
          const isInvoiceCreated = response.data?.actionResult?.success &&
                                   createdInvoice?.clientName &&
                                   createdInvoice?.amount &&
                                   createdInvoice?.date;

          if (isInvoiceCreated) {
            const pdfBuffer = await generateInvoicePDF(createdInvoice);
            const base64PDF = pdfBuffer.toString('base64');
            const media = new MessageMedia("application/pdf", base64PDF, `invoice-${createdInvoice.invoiceNumber || createdInvoice._id}.pdf`);

            if (userUsedVoiceNote) {
              const tts = await openai.audio.speech.create({
                model: "tts-1",
                input: aiResponse,
                voice: "nova",
                response_format: "mp3"
              });

              const audioBuffer = Buffer.from(await tts.arrayBuffer());
              const audioMedia = new MessageMedia("audio/mpeg", audioBuffer.toString("base64"));
              await msg.reply(audioMedia);
            } else {
              await msg.reply(aiResponse);
            }

            await msg.reply(media);
            return;
          }

          if (userUsedVoiceNote) {
            const tts = await openai.audio.speech.create({
              model: "tts-1",
              input: aiResponse,
              voice: "nova",
              response_format: "mp3"
            });

            const audioBuffer = Buffer.from(await tts.arrayBuffer());
            const audioMedia = new MessageMedia("audio/mpeg", audioBuffer.toString("base64"));
            await msg.reply(audioMedia);
          } else {
            await msg.reply(aiResponse);
          }

        } catch (err) {
          console.error("❌ Error handling AI response:", err);
          msg.reply("Something went wrong while generating a response.");
        }
      }
    };

    await sendMessage(mockReq, mockRes, (err) => {
      if (err) {
        console.error('❌ sendMessage error:', err);
        msg.reply("Something went wrong while processing your message.");
      }
    });

  } catch (error) {
    console.error('💥 Fatal error in message handler:', error);
    // Don't send any response for errors either to unregistered users
    if (user) { // Only respond if user exists (was found earlier)
      msg.reply('Something went wrong on our end.');
    }
  }
}

module.exports = { handleWhatsAppMessage };