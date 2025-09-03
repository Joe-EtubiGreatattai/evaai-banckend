require("dotenv").config();
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 🎯 Define the input text
const inputText = `Welcome to Rateo, the platform where employers and employees rate each other to create a balanced and transparent work environment. As a company, you’ll start by selecting 'Company' on the first screen, with options to choose either 'Individual' or 'Company.'

If you’re new, simply create an account. Already have one? Log in, and you’re ready to get started.

Once logged in, you’ll land on the Home Page. Here, you can browse through candidates who are looking for jobs. Swipe right to like a candidate, or swipe left to dislike them. You can click on a candidate's profile to view more details about them and even send them a message directly.

Head over to the Explore Page, where you’ll find all candidates available on Rateo, including the top-rated candidates. This gives you the opportunity to discover highly-rated talent for your company.

On the Rating Page, you can view your company's rating and provide feedback by rating your employees. Share your thoughts and help maintain transparency within your company.

The Candidates Page allows you to post job openings and view candidates who have applied for your jobs. You can easily see who is interested and ready to work with your company.

Finally, the Profile Page lets you edit your company profile and update preferences that will influence the types of candidates you see on Rateo, ensuring a better match for your hiring needs.

Rateo also prioritizes security. To ensure credibility, both companies and employees must complete the Know Your Customer (KYC) process before accessing the full app features. This helps keep Rateo a trusted platform for everyone.`;

// 🔊 Set voice name here
const voice = "shimmer";

function getNextFileName(baseName) {
  const files = fs.readdirSync(__dirname);
  let maxNum = 0;

  files.forEach((file) => {
    const match = file.match(new RegExp(`^${baseName}-(\\d+)\\.mp3$`));
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  });

  return `${baseName}-${maxNum + 1}.mp3`;
}

(async () => {
  if (!inputText) {
    console.log("❌ No input text defined.");
    return;
  }

  try {
    console.log(`🎧 Generating speech with voice: ${voice}...`);

    const speechResponse = await openai.audio.speech.create({
      model: "tts-1",
      input: inputText,
      voice,
      response_format: "mp3"
    });

    const buffer = Buffer.from(await speechResponse.arrayBuffer());
    const filename = getNextFileName("rateo-voice");
    const outputPath = path.join(__dirname, filename);
    fs.writeFileSync(outputPath, buffer);

    console.log(`✅ Voiceover saved to: ${outputPath}`);
  } catch (err) {
    console.error("❌ Error generating speech:", err.message || err);
  }
})();
