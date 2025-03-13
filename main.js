const Groq = require('groq-sdk');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// Initialize Groq client only when needed
let groq;
function initGroq() {
  if (!groq) {
    groq = new Groq();
  }
  return groq;
}

// Configuration for token management
const MAX_CONTEXT_TOKENS = 128000; // 128K context window
const TOKEN_BUFFER = 10000; // Safety buffer to prevent overflows
const ESTIMATED_TOKENS_PER_CHAR = 0.25; // Approximate token/character ratio

// Function to check if directory exists
async function directoryExists(dirPath) {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
}

// Function to check if file exists
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

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
      The book should be structured for approximately 300 pages with 10-15 chapters.
      IMPORTANT: Each chapter outline should be detailed enough to support writing a full 20-30 page chapter 
      (5,000-7,500 words). Provide rich details about plot events, character development, and 
      key scenes for each chapter.`
    },
    {
      role: "user",
      content: `Based on this concept: "${concept}"
      
      Please create a detailed outline for this ${genre} book including:
      1. A refined title if necessary
      2. Main characters with brief descriptions (personality, motivations, arc)
      3. Setting details
      4. A chapter-by-chapter breakdown. For EACH chapter provide 3-5 paragraphs describing:
         - The main plot points and events
         - Key character interactions and developments
         - Important revelations or twists
         - Setting and atmosphere
         - Beginning and ending hooks
      5. Major plot points and themes
      6. Any special elements relevant to the ${genre} (e.g. technology for sci-fi, monsters for horror)
      
      Aim for 10-15 chapters total for a 300-page book. Remember each chapter needs to be developed enough 
      to be written as a full 20-30 page chapter with rich detail.`
    }
  ];
  
  const response = await callGroq(prompt);
  
  // Save the outline
  await fs.writeFile(`${outputDir}/book_outline.txt`, response);
  
  return response;
}

// Function to extract the number of chapters from the outline
function extractChapterCount(outline) {
  // First, check for explicit mention of total chapter count
  const totalChaptersMatch = outline.match(/(\d+|ten|twelve|fifteen)\s+chapters/i);
  if (totalChaptersMatch) {
    const chapterCount = totalChaptersMatch[1].toLowerCase();
    const numberMap = {
      'ten': 10,
      'twelve': 12,
      'fifteen': 15
    };
    return numberMap[chapterCount] || parseInt(chapterCount);
  }
  
  // Look for patterns like "Chapter 1", "Chapter One", etc. to count chapters
  const chapterMatches = outline.match(/chapter\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)/gi);
  
  if (chapterMatches) {
    return new Set(chapterMatches.map(match => match.toLowerCase())).size;
  }
  
  // If we can't determine the number, default to 10 chapters
  console.log("Could not determine chapter count from outline. Using default of 10 chapters.");
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
      Write in a compelling, engaging style appropriate for the ${genre} genre. 
      
      IMPORTANT: This should be a complete, full-length chapter of approximately 20-30 pages (around 5,000-7,500 words).
      Do NOT write a short summary or outline. The chapter should be publication-ready, detailed prose with rich description,
      dialogue, character development, and plot advancement.
      
      Include dialogue, description, action, and inner thoughts as appropriate.`
    },
    {
      role: "user",
      content: `Using this context information: "${context.substring(0, 10000)}"
      
      Write Chapter ${chapterNum} in full, detailed prose. This should be a complete chapter of approximately 20-30 pages (5,000-7,500 words), 
      not a summary or outline. The chapter should read like it's from a published novel.
      
      - Maintain consistent characterization based on the profiles
      - Follow the plot points for this chapter from the outline
      - Ensure continuity with previous chapters if applicable
      - Use a writing style appropriate for ${genre} fiction
      - Include chapter title/number at the beginning
      - Write rich, immersive scenes with appropriate pacing
      - End the chapter with an appropriate hook or resolution
      - Include detailed descriptions, meaningful dialogue, and character development
      - Convey emotions and sensory details to make the story come alive
      
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

// Function to expand and enhance a chapter
async function enhanceChapter(genre, chapterNum, originalChapter, chapterSummaries, bookOutline, outputDir) {
  console.log(`Enhancing Chapter ${chapterNum}...`);
  
  // Create context for enhancement, including the chapter summaries to maintain continuity
  let summaryText = '';
  if (chapterSummaries && chapterSummaries.length > 0) {
    summaryText = chapterSummaries.join('\n\n');
  }
  
  const prompt = [
    {
      role: "system",
      content: `You are a professional ${genre} editor and author known for creating rich, immersive prose 
      with compelling characterization and vivid description. Your task is to enhance and expand an existing 
      chapter by adding more descriptive details, sensory information, character development, internal monologue, 
      dialogue, and world-building elements.
      
      DO NOT rewrite the entire chapter or change the plot. Instead, you should:
      1. Identify areas where description is sparse and add vivid sensory details
      2. Expand dialogue scenes with more nuanced conversation and body language
      3. Add internal thoughts and emotional reactions from characters
      4. Enrich world-building elements and setting descriptions
      5. Deepen character development through additional interactions or reflections
      6. Ensure pacing is appropriate, expanding fast-moving scenes that need more development
      7. Maintain the original author's voice and style while improving the chapter`
    },
    {
      role: "user",
      content: `I have a chapter from a ${genre} novel that needs enhancement. Please expand this chapter by 
      adding more depth, detail, and richness while maintaining the original story structure and plot points. 
      The chapter should grow by approximately 150-200% in length.
      
      Here is some context information to ensure continuity:
      
      BOOK OUTLINE EXCERPT:
      ${bookOutline.substring(0, 2000)}...
      
      CHAPTER SUMMARIES:
      ${summaryText}
      
      ORIGINAL CHAPTER ${chapterNum}:
      ${originalChapter}
      
      Please enhance this chapter by adding more descriptive details, deeper character moments, 
      expanded dialogue, internal thoughts, sensory information, and richer world-building. 
      Do not change the major plot points or overall structure, but find places where the narrative 
      could be enriched and expanded.`
    }
  ];
  
  const enhancedContent = await callGroq(prompt);
  
  // Function to count words in a text
  const countWords = text => text.trim().split(/\s+/).length;
  
  // Get word counts
  const originalWordCount = countWords(originalChapter);
  const enhancedWordCount = countWords(enhancedContent);
  
  // Calculate the growth ratio
  const growthRatio = enhancedWordCount / originalWordCount;
  
  // Only save if the enhanced version is substantially longer (at least 20% longer)
  if (growthRatio >= 1.2) {
    console.log(`Chapter ${chapterNum} enhanced successfully:`);
    console.log(`- Original word count: ${originalWordCount}`);
    console.log(`- Enhanced word count: ${enhancedWordCount}`);
    console.log(`- Growth ratio: ${(growthRatio * 100).toFixed(1)}%`);
    
    // Save directly to the original chapter file
    const chapterPath = path.join(outputDir, 'chapters', `chapter_${chapterNum}.txt`);
    await fs.writeFile(chapterPath, enhancedContent);
    
    // Also create a backup of the original just in case
    const backupDir = path.join(outputDir, 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `chapter_${chapterNum}_original.txt`);
    await fs.writeFile(backupPath, originalChapter);
    
    return enhancedContent;
  } else {
    console.log(`Chapter ${chapterNum} enhancement skipped:`);
    console.log(`- Original word count: ${originalWordCount}`);
    console.log(`- Enhanced word count: ${enhancedWordCount}`);
    console.log(`- Growth ratio: ${(growthRatio * 100).toFixed(1)}%`);
    console.log('Enhanced version not substantially longer than original - keeping original version');
    
    return originalChapter;
  }
}

// Function to create a formatted PDF from the book content
async function createBookPDF(title, genre, chapters, outputDir) {
  console.log("Starting PDF creation process...");
  console.log(`Title: ${title}`);
  console.log(`Genre: ${genre}`);
  console.log(`Number of chapters: ${chapters.length}`);
  console.log(`Output directory: ${outputDir}`);

  try {
    // Create a new PDF document
    console.log("Creating new PDF document...");
    const pdfDoc = await PDFDocument.create();
    
    // Embed the font
    console.log("Embedding fonts...");
    const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    const italicFont = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);
    
    // Add title page
    console.log("Adding title page...");
    const titlePage = pdfDoc.addPage([612, 792]); // US Letter size
    const { width, height } = titlePage.getSize();
    
    // Add title
    titlePage.drawText(title, {
      x: (width - boldFont.widthOfTextAtSize(title, 40)) / 2, // Center the title
      y: height - 200,
      size: 40,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // Add genre
    const genreText = `A ${genre} Novel`;
    titlePage.drawText(genreText, {
      x: (width - font.widthOfTextAtSize(genreText, 20)) / 2, // Center the genre
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
      // Extract chapter title if present
      let chapterTitle = `Chapter ${index + 1}`;
      const titleMatch = chapterContent.match(/^\s*(?:\*\*)?Chapter\s+\d+(?:[:.]\s*|\s+)([^\n*]+)(?:\*\*)?/i);
      if (titleMatch && titleMatch[1]) {
        chapterTitle = `Chapter ${index + 1}: ${titleMatch[1].trim()}`;
      }
      
      // Clean chapter content - remove markdown-style chapter headings
      let cleanedContent = chapterContent
        .replace(/^\s*(?:\*\*)?Chapter\s+\d+(?:[:.]\s*|\s+)([^\n]+)(?:\*\*)?/i, '')
        .trim();
      
      // Split content into paragraphs, preserving intentional line breaks
      const paragraphs = cleanedContent
        .split(/\n\s*\n/) // Split on blank lines
        .map(p => p.trim())
        .filter(p => p.length > 0);
      
      // Add chapter page
      const chapterPage = pdfDoc.addPage([612, 792]);
      let y = height - 150; // Start lower to leave room for chapter title
      const lineHeight = 15;
      const paragraphSpacing = lineHeight * 1.5; // Space between paragraphs
      const margins = { left: 72, right: 72 }; // 1-inch margins
      const textWidth = width - margins.left - margins.right;
      
      // Draw chapter title centered
      const titleWidth = boldFont.widthOfTextAtSize(chapterTitle, 24);
      chapterPage.drawText(chapterTitle, {
        x: (width - titleWidth) / 2,
        y: height - 100,
        size: 24,
        font: boldFont,
        color: rgb(0, 0, 0),
      });
      
      // Track current page
      let currentPage = chapterPage;
      
      // Process each paragraph
      for (const paragraph of paragraphs) {
        // Split paragraph into words
        const words = paragraph.split(/\s+/);
        let currentLine = '';
        const lines = [];
        
        // Form lines that fit within margins
        for (const word of words) {
          const testLine = currentLine ? `${currentLine} ${word}` : word;
          const textWidth = font.widthOfTextAtSize(testLine, 12);
          
          if (textWidth < width - margins.left - margins.right) {
            currentLine = testLine;
          } else {
            lines.push(currentLine);
            currentLine = word;
          }
        }
        if (currentLine) lines.push(currentLine);
        
        // Check if we need a new page before starting this paragraph
        const paragraphHeight = lines.length * lineHeight;
        if (y - paragraphHeight < 50) {
          currentPage = pdfDoc.addPage([612, 792]);
          y = height - 50;
        }
        
        // Add the lines of this paragraph
        for (const line of lines) {
          currentPage.drawText(line, {
            x: margins.left,
            y,
            size: 12,
            font: font,
            color: rgb(0, 0, 0),
          });
          
          y -= lineHeight;
        }
        
        // Add extra space after each paragraph
        y -= paragraphSpacing;
      }
    }
    
    // Save the PDF
    const pdfBytes = await pdfDoc.save();
    const pdfPath = `${outputDir}/${title.replace(/\s+/g, '_')}.pdf`;
    await fs.writeFile(pdfPath, pdfBytes);
    
    console.log(`PDF saved as ${pdfPath}`);
    return pdfPath;
  } catch (error) {
    console.error("Error creating PDF:", error);
    throw error;
  }
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

// Function to find all chapter files in a directory
async function findChapterFiles(chaptersDir) {
  try {
    const files = await fs.readdir(chaptersDir);
    
    // Filter for chapter files
    const chapterFiles = files
      .filter(file => 
        file.match(/chapter_\d+\.txt$/i) &&
        !file.match(/enhanced\.txt$/i) // Exclude files with "enhanced" in the name
      )
      .sort((a, b) => {
        // Extract chapter numbers and sort numerically
        const numA = parseInt(a.match(/chapter_(\d+)\.txt/i)[1]);
        const numB = parseInt(b.match(/chapter_(\d+)\.txt/i)[1]);
        return numA - numB;
      });
    
    return chapterFiles;
  } catch (error) {
    console.error('Error finding chapter files:', error);
    return [];
  }
}

// Function to read chapter content
async function readChapterContents(chaptersDir, chapterFiles) {
  const chapters = [];
  
  for (const file of chapterFiles) {
    try {
      const content = await fs.readFile(path.join(chaptersDir, file), 'utf8');
      chapters.push(content);
    } catch (error) {
      console.error(`Error reading chapter file ${file}:`, error);
    }
  }
  
  return chapters;
}

// Function to get book information from directory
async function getBookInfoFromDirectory(bookDir) {
  console.log(`Getting book information from ${bookDir}...`);
  const bookInfo = {
    title: '',
    genre: '',
    outline: '',
    characterProfiles: ''
  };
  
  try {
    // Try to read the title file
    if (await fileExists(path.join(bookDir, 'title.txt'))) {
      bookInfo.title = (await fs.readFile(path.join(bookDir, 'title.txt'), 'utf8')).trim();
    } else {
      // If no title file, use directory name as title
      bookInfo.title = path.basename(bookDir).replace(/_/g, ' ');
    }
    
    // Try to read the outline
    if (await fileExists(path.join(bookDir, 'book_outline.txt'))) {
      bookInfo.outline = await fs.readFile(path.join(bookDir, 'book_outline.txt'), 'utf8');
      
      // Try to extract genre from outline if it exists
      const genreMatch = bookInfo.outline.match(/genre:\s*([^\n.,]+)/i);
      if (genreMatch && genreMatch[1]) {
        bookInfo.genre = genreMatch[1].trim().toLowerCase();
      }
    }
    
    // Try to read character profiles
    if (await fileExists(path.join(bookDir, 'character_profiles.txt'))) {
      bookInfo.characterProfiles = await fs.readFile(path.join(bookDir, 'character_profiles.txt'), 'utf8');
    }
    
    // If genre still not found, try to infer from book concept or use "fiction" as default
    if (!bookInfo.genre && await fileExists(path.join(bookDir, 'book_concept.txt'))) {
      const concept = await fs.readFile(path.join(bookDir, 'book_concept.txt'), 'utf8');
      const conceptGenreMatch = concept.match(/genre:\s*([^\n.,]+)/i);
      if (conceptGenreMatch && conceptGenreMatch[1]) {
        bookInfo.genre = conceptGenreMatch[1].trim().toLowerCase();
      } else {
        bookInfo.genre = 'fiction';
      }
    } else if (!bookInfo.genre) {
      bookInfo.genre = 'fiction';
    }
    
    return bookInfo;
  } catch (error) {
    console.error(`Error getting book info from directory: ${error.message}`);
    throw error;
  }
}

// Main execution
async function main() {
  try {
    const args = process.argv.slice(2);
    
    // Handle PDF generation
    if (args[0] === '--pdf') {
      const bookTitle = args[1];
      if (!bookTitle) {
        console.error('Please provide a book title for PDF generation');
        process.exit(1);
      }
      
      const bookDir = `./output/${bookTitle}`;
      if (!await directoryExists(bookDir)) {
        console.error(`Book directory not found: ${bookDir}`);
        process.exit(1);
      }
      
      // Get book info
      const bookInfo = await getBookInfoFromDirectory(bookDir);
      
      // Get chapter files
      const chaptersDir = path.join(bookDir, 'chapters');
      const chapterFiles = (await fs.readdir(chaptersDir))
        .filter(file => file.match(/^chapter_\d+\.txt$/))
        .sort((a, b) => {
          const numA = parseInt(a.match(/\d+/)[0]);
          const numB = parseInt(b.match(/\d+/)[0]);
          return numA - numB;
        });
      
      if (chapterFiles.length === 0) {
        console.error('No chapter files found');
        process.exit(1);
      }
      
      // Read chapters
      const chapters = await readChapterContents(chaptersDir, chapterFiles);
      
      // Generate PDF
      await createBookPDF(bookInfo.title, bookInfo.genre, chapters, bookDir);
      return;
    }
    
    // Handle enhance command
    if (args[0] === '--enhance') {
      const bookTitle = args[1];
      if (!bookTitle) {
        console.error('Please provide a book title for enhancement');
        process.exit(1);
      }
      
      const bookDir = `./output/${bookTitle}`;
      if (!await directoryExists(bookDir)) {
        console.error(`Book directory not found: ${bookDir}`);
        process.exit(1);
      }
      
      // Get book info
      const bookInfo = await getBookInfoFromDirectory(bookDir);
      
      // Get chapter files
      const chaptersDir = path.join(bookDir, 'chapters');
      const chapterFiles = await findChapterFiles(chaptersDir);
      
      if (chapterFiles.length === 0) {
        console.error('No chapter files found');
        process.exit(1);
      }
      
      // Parse chapter range if provided
      let startChapter = 1;
      let endChapter = chapterFiles.length;
      
      if (args[2] && args[3]) {
        startChapter = parseInt(args[2]);
        endChapter = parseInt(args[3]);
        
        if (isNaN(startChapter) || isNaN(endChapter) || 
            startChapter < 1 || endChapter > chapterFiles.length ||
            startChapter > endChapter) {
          console.error(`Invalid chapter range. Please specify numbers between 1 and ${chapterFiles.length}`);
          process.exit(1);
        }
      }
      
      console.log(`Enhancing chapters ${startChapter} to ${endChapter}...`);
      
      // Initialize Groq here, only when we know we need it
      initGroq();
      
      // Get all chapter summaries for context
      const summaries = [];
      for (let i = 0; i < startChapter - 1; i++) {
        const summaryPath = path.join(bookDir, 'summaries', `chapter_${i + 1}_summary.txt`);
        if (await fileExists(summaryPath)) {
          const summary = await fs.readFile(summaryPath, 'utf8');
          summaries.push(summary);
        }
      }
      
      // Process each chapter in range
      for (let i = startChapter - 1; i < endChapter; i++) {
        const chapterNum = i + 1;
        console.log(`\nEnhancing Chapter ${chapterNum}...`);
        
        const chapterPath = path.join(chaptersDir, chapterFiles[i]);
        const chapterContent = await fs.readFile(chapterPath, 'utf8');
        
        try {
          const enhancedContent = await enhanceChapter(
            bookInfo.genre,
            chapterNum,
            chapterContent,
            summaries,
            bookInfo.outline,
            bookDir
          );
          
          // Add this chapter's summary to the context for next chapters
          const summaryPath = path.join(bookDir, 'summaries', `chapter_${chapterNum}_summary.txt`);
          if (await fileExists(summaryPath)) {
            const summary = await fs.readFile(summaryPath, 'utf8');
            summaries.push(summary);
          }
          
          console.log(`Successfully enhanced Chapter ${chapterNum}`);
        } catch (error) {
          console.error(`Error enhancing Chapter ${chapterNum}:`, error);
          // Continue with next chapter even if one fails
        }
      }
      
      console.log('\nEnhancement complete!');
      return;
    }
    
    // For all other operations, initialize Groq
    initGroq();
    
    // Rest of the existing main function code...
  } catch (error) {
    console.error('Error in main execution:', error);
    process.exit(1);
  }
}

main();