const Groq = require('groq-sdk');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// Initialize Groq client
const groq = new Groq();

// Configuration for token management
const MAX_CONTEXT_TOKENS = 128000; // 128K context window
const TOKEN_BUFFER = 10000; // Safety buffer to prevent overflows
const ESTIMATED_TOKENS_PER_CHAR = 0.25; // Approximate token/character ratio

// Create output directories if they don't exist
async function initializeDirectories(bookTitle) {
  // Sanitize the title for use as a directory name
  const safeTitle = bookTitle 
    ? bookTitle.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').toLowerCase()
    : 'untitled_book';
  
  // Further limit directory name length to avoid filesystem issues
  const safeDirName = safeTitle.length > 50 ? safeTitle.substring(0, 50) : safeTitle;
  
  const baseDir = `./output/${safeDirName}`;
  const dirs = [baseDir, `${baseDir}/chapters`, `${baseDir}/summaries`];
  
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error(`Error creating directory ${dir}:`, error);
    }
  }
  
  return baseDir;
}

// Function to call Groq API with retry logic
async function callGroq(messages, maxRetries = 3, retryDelay = 5000) {
  let attempts = 0;
  
  while (attempts < maxRetries) {
    try {
      let fullResponse = '';
      
      const chatCompletion = await groq.chat.completions.create({
        messages,
        model: "deepseek-r1-distill-llama-70b",
        temperature: 0.6,
        max_completion_tokens: 48000,
        top_p: 0.95,
        stream: true,
        stop: null
      });
      
      process.stdout.write('\n'); // Start on a new line
      
      for await (const chunk of chatCompletion) {
        const content = chunk.choices[0]?.delta?.content || '';
        fullResponse += content;
        process.stdout.write(content);
      }
      
      process.stdout.write('\n\n'); // Add spacing after completion
      
      // Clean up possible thinking out loud in the response
      if (fullResponse.includes('<think>') && fullResponse.includes('</think>')) {
        console.log("Detected thinking markers in the response. Removing thinking section...");
        fullResponse = fullResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
      
      // Look for patterns that indicate thinking out loud
      const thinkingPatterns = [
        /^I need to come up with/i,
        /^Let me think about/i,
        /^I'll create a/i,
        /^Okay, so I/i,
        /^I should start by/i,
        /^First, I'll/i,
        /^Let's brainstorm/i
      ];
      
      for (const pattern of thinkingPatterns) {
        if (pattern.test(fullResponse)) {
          console.log("Detected thinking pattern in the response. Attempting to extract final content...");
          
          // Try to find the final result after thinking
          const finalContentPatterns = [
            /\*\*([^*]+(?:\*(?!\*)[^*]+)*)\*\*/g, // Content between ** markers
            /(?:Here's my final|Here is the|Final concept|Here's the concept):([\s\S]*?)(?:$|(?=\n\n))/i,
            /(?:Title:|Main Premise:|Key Themes:)([\s\S]*?)(?:$|(?=\n\n))/i
          ];
          
          for (const pattern of finalContentPatterns) {
            const matches = fullResponse.match(pattern);
            if (matches && matches.length > 0) {
              // Found what appears to be the final content
              const extractedContent = matches.join('\n\n');
              console.log("Extracted what appears to be the final content.");
              fullResponse = extractedContent;
              break;
            }
          }
          
          break;
        }
      }
      
      // If this is a title generation call, validate and clean the response
      if (messages.some(msg => msg.content.includes('Return ONLY the title'))) {
        // Check if response is too long or has multiple lines (likely thinking out loud)
        if (fullResponse.length > 100 || fullResponse.includes('\n')) {
          console.log("Warning: Title response may contain reasoning. Attempting to extract just the title...");
          
          // Look for what seems to be the actual title
          const titleMatch = fullResponse.match(/["']([^"']+)["']/) || // Quoted text
                            fullResponse.match(/^([A-Z][^.!?\n]{1,50})(?:[.!?]|$)/m) || // Capitalized phrase
                            fullResponse.match(/I'll go with\s+["']?([^"'\n.]+)["']?/i); // "I'll go with X"
          
          if (titleMatch && titleMatch[1]) {
            console.log(`Extracted title: "${titleMatch[1]}"`);
            return titleMatch[1];
          }
          
          // If we couldn't extract a clear title, generate a default
          const timestamp = Date.now().toString(36);
          return `Book_${timestamp}`;
        }
      }
      
      return fullResponse;
    } catch (error) {
      attempts++;
      console.error(`\nAPI call failed (attempt ${attempts}/${maxRetries}):`, error.message);
      
      if (attempts >= maxRetries) {
        throw new Error(`Failed after ${maxRetries} attempts: ${error.message}`);
      }
      
      console.log(`Retrying in ${retryDelay/1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// Function to generate a book concept if no topic is provided
async function generateBookConcept(genre, tempDir) {
  console.log(`Generating a book concept for ${genre} genre...`);
  
  const prompt = [
    {
      role: "system", 
      content: `You are a professional ${genre} author with expertise in creating compelling book concepts. 
      Generate a high-level overview for a ${genre} book, including a potential title, main premise, and key themes.
      Be creative and original. The concept should be suitable for a book of approximately 300 pages.
      IMPORTANT: Do not include your thought process in the response. Provide only the final concept.`
    },
    {
      role: "user",
      content: `Create an original and engaging book concept for the ${genre} genre. 
      Include a potential title and a brief 1-2 paragraph overview of what the book would be about.
      Return only the final concept without any explanations of your process.`
    }
  ];
  
  const response = await callGroq(prompt);
  
  // Save the concept to the temporary directory
  if (tempDir) {
    try {
      await fs.writeFile(`${tempDir}/book_concept.txt`, response);
    } catch (error) {
      console.warn("Warning: Could not save concept to temporary file:", error.message);
    }
  }
  
  return response;
}

// Function to develop detailed book outline
async function developBookOutline(genre, concept, outputDir) {
  console.log("Developing detailed book outline...");
  
  const prompt = [
    {
      role: "system",
      content: `You are a professional ${genre} author and master of story structure.
      Your task is to develop a detailed outline for a ${genre} book based on the provided concept.
      The book should be structured for approximately 300 pages with 10-15 chapters.`
    },
    {
      role: "user",
      content: `Based on this concept: "${concept}"
      
      Please create a detailed outline for this ${genre} book including:
      1. A refined title if necessary
      2. Main characters with brief descriptions (personality, motivations, arc)
      3. Setting details
      4. A chapter-by-chapter breakdown with 1-2 paragraphs per chapter describing key events
      5. Major plot points and themes
      6. Any special elements relevant to the ${genre} (e.g. technology for sci-fi, monsters for horror)
      
      Aim for 10-15 chapters total for a 300-page book.`
    }
  ];
  
  const response = await callGroq(prompt);
  
  // Save the outline
  await fs.writeFile(`${outputDir}/book_outline.txt`, response);
  
  return response;
}

// Function to extract the number of chapters from the outline
function extractChapterCount(outline) {
  // Look for patterns like "Chapter 1", "Chapter One", etc. to count chapters
  const chapterMatches = outline.match(/chapter\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)/gi);
  
  if (chapterMatches) {
    return new Set(chapterMatches.map(match => match.toLowerCase())).size;
  }
  
  // Default to 10 chapters if we can't determine
  return 10;
}

// Function to create character profiles
async function createCharacterProfiles(genre, outline, outputDir) {
  console.log("Creating detailed character profiles...");
  
  const prompt = [
    {
      role: "system",
      content: `You are a professional ${genre} author with expertise in character development.
      Based on the book outline, create detailed character profiles for all major and supporting characters.`
    },
    {
      role: "user",
      content: `Using this book outline: "${outline.substring(0, 8000)}"
      
      Create detailed character profiles for all major and supporting characters mentioned in the outline.
      For each character include:
      1. Full name
      2. Age, physical appearance
      3. Background/history
      4. Personality traits, strengths and flaws
      5. Motivations and goals
      6. Character arc throughout the story
      7. Relationships with other characters
      8. Any special abilities or traits relevant to the ${genre}
      
      Organize this as a reference document that will help guide consistent character portrayal throughout the book.`
    }
  ];
  
  const response = await callGroq(prompt);
  
  // Save the character profiles
  await fs.writeFile(`${outputDir}/character_profiles.txt`, response);
  
  return response;
}

// Function to prepare a chapter for writing
async function prepareChapter(genre, chapterNum, outline, characterProfiles, previousChapterSummaries = [], outputDir) {
  console.log(`Preparing to write Chapter ${chapterNum}...`);
  
  // Combine previous chapter summaries, keeping within token limits
  let summariesText = '';
  if (previousChapterSummaries.length > 0) {
    summariesText = `\nPrevious Chapter Summaries:\n${previousChapterSummaries.join('\n\n')}`;
  }
  
  // Estimate token count and truncate if necessary
  let characterProfilesText = characterProfiles;
  const estimatedTokens = (outline.length + characterProfilesText.length + summariesText.length) * ESTIMATED_TOKENS_PER_CHAR;
  
  if (estimatedTokens > MAX_CONTEXT_TOKENS - TOKEN_BUFFER) {
    const availableChars = Math.floor((MAX_CONTEXT_TOKENS - TOKEN_BUFFER) / ESTIMATED_TOKENS_PER_CHAR);
    const outlineChars = Math.floor(availableChars * 0.3); // 30% for outline
    const profilesChars = Math.floor(availableChars * 0.3); // 30% for profiles
    const summariesChars = Math.floor(availableChars * 0.4); // 40% for summaries
    
    // Truncate each component to fit
    const truncatedOutline = outline.substring(0, outlineChars);
    characterProfilesText = characterProfilesText.substring(0, profilesChars);
    const truncatedSummaries = summariesText.substring(0, summariesChars);
    
    console.log("Context window limit approaching - truncating context materials...");
    
    // Prepare a compressed version
    const prompt = [
      {
        role: "system",
        content: `You are an AI assistant specialized in summarizing and compressing information while maintaining all key details.`
      },
      {
        role: "user",
        content: `The following book materials need to be compressed while retaining all essential information for writing Chapter ${chapterNum}:
        
        OUTLINE: ${truncatedOutline}
        
        CHARACTER PROFILES: ${characterProfilesText}
        
        ${truncatedSummaries}
        
        Please create a compressed version that maintains all key plot points, character details, and continuity information needed to write Chapter ${chapterNum} of this ${genre} book.`
      }
    ];
    
    const compressedContext = await callGroq(prompt);
    await fs.writeFile(`${outputDir}/compressed_context_ch${chapterNum}.txt`, compressedContext);
    
    return compressedContext;
  }
  
  // If we're within token limits, return the full context
  return `BOOK OUTLINE:\n${outline}\n\nCHARACTER PROFILES:\n${characterProfilesText}${summariesText}`;
}

// Function to write a specific chapter
async function writeChapter(genre, chapterNum, context, outputDir) {
  console.log(`Writing Chapter ${chapterNum}...`);
  
  const prompt = [
    {
      role: "system",
      content: `You are a professional ${genre} author. Your task is to write Chapter ${chapterNum} of a book based on provided context.
      Write in a compelling, engaging style appropriate for the ${genre} genre. Aim for approximately 20-30 pages of content 
      (around 5,000-7,500 words). Include dialogue, description, action, and inner thoughts as appropriate.`
    },
    {
      role: "user",
      content: `Using this context information: "${context.substring(0, 10000)}"
      
      Write Chapter ${chapterNum} in full. This should be publication-ready prose, not an outline.
      
      - Maintain consistent characterization based on the profiles
      - Follow the plot points for this chapter from the outline
      - Ensure continuity with previous chapters if applicable
      - Use a writing style appropriate for ${genre} fiction
      - Include chapter title/number at the beginning
      - Write rich, immersive scenes with appropriate pacing
      - End the chapter with an appropriate hook or resolution
      
      Focus on quality prose that would engage readers of ${genre} fiction.`
    }
  ];
  
  const response = await callGroq(prompt);
  
  // Save the chapter
  await fs.writeFile(`${outputDir}/chapters/chapter_${chapterNum}.txt`, response);
  
  return response;
}

// Function to summarize a chapter for context in subsequent chapters
async function summarizeChapter(genre, chapterNum, chapterContent, outputDir) {
  console.log(`Summarizing Chapter ${chapterNum} for context...`);
  
  const prompt = [
    {
      role: "system",
      content: `You are a professional editor specializing in ${genre} fiction. 
      Create a concise but comprehensive summary of the provided chapter.`
    },
    {
      role: "user",
      content: `Summarize the following chapter content from a ${genre} book:
      
      "${chapterContent.substring(0, 10000)}"
      
      Create a summary that captures all key events, character developments, plot advancements, and important details 
      that would be needed for maintaining continuity in subsequent chapters.
      
      The summary should be approximately 500-800 words.`
    }
  ];
  
  const response = await callGroq(prompt);
  
  // Save the summary
  await fs.writeFile(`${outputDir}/summaries/chapter_${chapterNum}_summary.txt`, response);
  
  return response;
}

// Function to create a formatted PDF from the book content
async function createBookPDF(title, genre, chapters, outputDir) {
  console.log("Creating formatted PDF...");
  
  // Create a new PDF document
  const pdfDoc = await PDFDocument.create();
  
  // Embed the font
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  
  // Add title page
  const titlePage = pdfDoc.addPage([612, 792]); // US Letter size
  const { width, height } = titlePage.getSize();
  
  // Add title
  titlePage.drawText(title, {
    x: 50,
    y: height - 200,
    size: 40,
    font: boldFont,
    color: rgb(0, 0, 0),
  });
  
  // Add genre
  titlePage.drawText(`A ${genre} Novel`, {
    x: 50,
    y: height - 250,
    size: 20,
    font: font,
    color: rgb(0, 0, 0),
  });
  
  // Add generated date
  const date = new Date().toLocaleDateString();
  titlePage.drawText(`Generated on ${date}`, {
    x: 50,
    y: 50,
    size: 12,
    font: font,
    color: rgb(0, 0, 0),
  });
  
  // Add each chapter
  for (const [index, chapterContent] of chapters.entries()) {
    // Split chapter text into lines that fit the page width
    const lines = [];
    const words = chapterContent.split(/\s+/);
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const textWidth = font.widthOfTextAtSize(testLine, 12);
      
      if (textWidth < width - 100) {
        currentLine = testLine;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    
    // Process lines into pages
    let page = pdfDoc.addPage([612, 792]);
    let y = height - 50;
    const lineHeight = 15;
    
    // Add chapter title at the top of the first page
    const chapterTitle = `Chapter ${index + 1}`;
    page.drawText(chapterTitle, {
      x: 50,
      y,
      size: 18,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    y -= lineHeight * 2;
    
    // Add paragraph text
    for (const line of lines) {
      if (y < 50) {
        page = pdfDoc.addPage([612, 792]);
        y = height - 50;
      }
      
      if (line.trim() === '') {
        // Add extra space for paragraph breaks
        y -= lineHeight;
        continue;
      }
      
      page.drawText(line, {
        x: 50,
        y,
        size: 12,
        font: font,
        color: rgb(0, 0, 0),
      });
      
      y -= lineHeight;
    }
  }
  
  // Save the PDF
  const pdfBytes = await pdfDoc.save();
  const pdfPath = `${outputDir}/${title.replace(/\s+/g, '_')}.pdf`;
  await fs.writeFile(pdfPath, pdfBytes);
  
  console.log(`PDF saved as ${pdfPath}`);
}

// Generate a specific title for the book
async function generateBookTitle(genre, concept) {
  console.log("Generating a specific title for the book...");
  
  const prompt = [
    {
      role: "system",
      content: `You are a professional book title creator with expertise in the ${genre} genre.
      Your task is to create a compelling, marketable title for a book based on the provided concept.
      IMPORTANT: Return ONLY the title itself, with no explanation, reasoning, or commentary.
      The title should be short (1-5 words) and memorable.`
    },
    {
      role: "user",
      content: `Based on this book concept: "${concept.substring(0, 1000)}"
      
      Create an original, compelling title for this ${genre} book. The title should:
      - Be memorable and catchy
      - Reflect the book's themes and content
      - Work well for the ${genre} genre
      - Be between 1-5 words (though subtitles are acceptable if appropriate)
      
      Return ONLY the title, nothing else. No explanations, no reasoning, no thought process.`
    }
  ];
  
  let response = await callGroq(prompt);
  
  // Clean up the response to ensure it's just the title
  let cleanTitle = response.trim()
    .replace(/^"(.+)"$/, '$1') // Remove quotes if present
    .replace(/^Title:?\s*/i, '') // Remove "Title:" prefix if present
    .replace(/[\r\n].*/gs, ''); // Remove anything after a newline
  
  // Limit title length for filesystem safety
  if (cleanTitle.length > 50) {
    cleanTitle = cleanTitle.substring(0, 47) + '...';
  }
  
  // If title is still problematic or empty, use a default
  if (!cleanTitle || cleanTitle.length < 2 || cleanTitle.length > 100) {
    cleanTitle = `${genre.charAt(0).toUpperCase() + genre.slice(1)}_Tale_${Date.now().toString(36)}`;
  }
  
  console.log(`Generated title: "${cleanTitle}"`);
  return cleanTitle;
}

// Extract title from outline as fallback
function extractTitle(outline) {
  // Look for patterns like "Title: My Book Title" or similar
  const titleMatch = outline.match(/title:?\s*([^\n]+)/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].trim();
  }
  
  // Look for text that might be a title (capitalized words at the beginning)
  const lines = outline.split('\n');
  for (const line of lines.slice(0, 5)) {
    const trimmedLine = line.trim();
    if (trimmedLine && trimmedLine === trimmedLine.toUpperCase() && trimmedLine.length > 3) {
      return trimmedLine;
    }
  }
  
  // Default title
  return "Untitled Book";
}

// Main function
async function main() {
  try {
    // Process command line arguments
    const args = process.argv.slice(2);
    const genre = args[0] || '';
    const topic = args[1] || '';
    
    if (!genre) {
      console.error('Error: Genre is required');
      console.log('Usage: node main.js <genre> [topic]');
      console.log('Example: node main.js scifi "colonization of Mars"');
      return;
    }
    
    console.log(`Starting book generation process for ${genre} genre${topic ? ` with topic: ${topic}` : ''}`);
    
    // Create a temporary output directory for initial files
    const tempDir = './output/temp_' + Date.now().toString(36);
    await fs.mkdir(tempDir, { recursive: true });
    
    // Step 1: Generate or use topic
    const bookConcept = topic || await generateBookConcept(genre, tempDir);
    console.log("\nBook Concept:", bookConcept, "\n");
    
    // Step 1.5: Generate a specific title
    const bookTitle = await generateBookTitle(genre, bookConcept);
    console.log(`\nGenerated book title: "${bookTitle}"\n`);
    
    // Initialize directories with the book title
    const outputDir = await initializeDirectories(bookTitle);
    
    // Save the book concept to the final directory
    await fs.writeFile(`${outputDir}/book_concept.txt`, bookConcept);
    
    // Step 2: Develop detailed book outline
    const bookOutline = await developBookOutline(genre, bookConcept, outputDir);
    console.log("\nBook Outline Complete\n");
    
    // Step 3: Create character profiles
    const characterProfiles = await createCharacterProfiles(genre, bookOutline, outputDir);
    console.log("\nCharacter Profiles Complete\n");
    
    // Use generated title, fallback to extracting from outline if needed
    const title = bookTitle || extractTitle(bookOutline);
    // Save final title
    await fs.writeFile(`${outputDir}/title.txt`, title);
    
    const chapterCount = extractChapterCount(bookOutline);
    console.log(`Book title: ${title}`);
    console.log(`Detected ${chapterCount} chapters\n`);
    
    // Step 4: Write each chapter and its summary
    const chapterContents = [];
    const chapterSummaries = [];
    
    for (let i = 1; i <= chapterCount; i++) {
      // Prepare context for this chapter
      const context = await prepareChapter(genre, i, bookOutline, characterProfiles, chapterSummaries, outputDir);
      
      // Write the chapter
      const chapterContent = await writeChapter(genre, i, context, outputDir);
      chapterContents.push(chapterContent);
      
      // Summarize the chapter for context in future chapters
      const summary = await summarizeChapter(genre, i, chapterContent, outputDir);
      chapterSummaries.push(`Chapter ${i}: ${summary}`);
      
      console.log(`\nCompleted Chapter ${i} of ${chapterCount}\n`);
    }
    
    // Step 5: Create PDF
    await createBookPDF(title, genre, chapterContents, outputDir);
    
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error("Warning: Could not remove temporary directory:", error.message);
    }
    
    console.log("\nBook generation complete!");
    console.log(`Book saved as: ${outputDir}/${title.replace(/\s+/g, '_')}.pdf`);
    console.log(`Individual chapters and other materials are available in the ${outputDir} directory`);
    
  } catch (error) {
    console.error("An error occurred during book generation:", error);
  }
}

// Run the program
main();
