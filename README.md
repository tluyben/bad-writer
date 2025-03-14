# 📚 Auto Book Generator 📚

## 🪄 Magical Book Creation Powered by Groq AI

This project automates the creation of full-length books in various genres using the Groq API. The script handles everything from concept generation to final PDF output, making it easy to create complete books with rich character development, detailed chapters, and engaging narratives.

## ✨ Features

- 🧠 **Dynamic Content Generation**: Create original book concepts or use your own ideas
- 📝 **Complete Book Structure**: From title to characters to fully-fleshed chapters
- 📊 **Intelligent Context Management**: Handles the 128K token context window efficiently
- 🔄 **Continuity Control**: Maintains narrative cohesion across chapters
- 📑 **PDF Generation**: Creates a properly formatted book ready for reading
- 🛡️ **Error Handling**: Robust retry logic and recovery systems
- 📁 **Organized Output**: Each book gets its own directory with all materials
- 🔁 **Continuation Support**: Resume interrupted work or run specific steps independently

## 🛠️ Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install groq-sdk pdf-lib
   ```
3. Set up your Groq API key:
   ```bash
   export GROQ_API_KEY=your_api_key_here
   ```

## 🚀 Usage

### Basic Book Generation

```bash
node main.js <genre> [topic] [chapterCount] [--no-enhance]
```

Examples:
```bash
# Generate a fantasy book with AI-created topic
node main.js fantasy

# Generate a sci-fi book about space exploration
node main.js scifi "interstellar colonization"

# Generate a horror book with exactly 15 chapters
node main.js horror "haunted lighthouse" 15

# Generate a thriller book without the enhancement phase
node main.js thriller "cold case mystery" --no-enhance
```

### Continuation Commands

Resume interrupted generation or run specific steps for existing books:

```bash
# Generate PDF from existing chapters
node main.js --pdf <book-title>

# Enhance specific chapters (or all if no range specified)
node main.js --enhance <book-title> [start-chapter] [end-chapter]

# Generate additional chapters for an existing book
node main.js --generate-chapters <book-title> [start-chapter] [end-chapter]

# Display help information
node main.js --help
```

Examples:
```bash
# Create PDF for "the_void_within" from existing chapters
node main.js --pdf the_void_within

# Enhance only chapters 3-5 of "the_void_within"
node main.js --enhance the_void_within 3 5

# Add chapters 16-20 to the existing book "the_void_within"
node main.js --generate-chapters the_void_within 16 20
```

## 📋 Process Steps

1. **Concept Creation**: Generates or uses a book concept
2. **Title Generation**: Creates a compelling title based on the concept
3. **Outline Development**: Builds a detailed chapter-by-chapter outline
4. **Character Creation**: Develops in-depth character profiles
5. **Chapter Writing**: Writes full-length chapters (20-30 pages each)
6. **Chapter Enhancement**: Expands each chapter with additional details and depth
7. **PDF Compilation**: Formats everything into a readable PDF

## 📊 Output Structure

For each book generated, the following directory structure is created:
```
output/
└── [book_title]/
    ├── book_concept.txt
    ├── book_outline.txt
    ├── character_profiles.txt
    ├── title.txt
    ├── [book_title].pdf
    ├── chapters/
    │   ├── chapter_1.txt
    │   ├── chapter_1_enhanced.txt
    │   ├── chapter_2.txt
    │   ├── chapter_2_enhanced.txt
    │   └── ...
    └── summaries/
        ├── chapter_1_summary.txt
        ├── chapter_2_summary.txt
        └── ...
```

## 🎛️ Configuration

The script uses the following default settings:
- **Book Length**: ~300 pages
- **Chapter Count**: 10-15 chapters (can be overridden)
- **Chapter Length**: 20-30 pages each (5,000-7,500 words)
- **LLM Model**: `deepseek-r1-distill-llama-70b`
- **Context Window**: 128K tokens

## 🔍 Tips for Best Results

- Fantasy and sci-fi genres tend to produce the most creative results
- Custom topics provide more focused books than auto-generated concepts
- Specifying chapter counts gives you more control over the book length
- Each book takes 1-3 hours to generate, depending on chapter count and length
- If generation is interrupted, use continuation commands to resume where you left off

## ⚠️ Limitations

- The content quality depends on the underlying Groq API
- Very specific genre combinations may need additional prompt engineering
- Token limits may require compression for extremely long or complex books
- API outages can interrupt the generation process (though the script has retry logic)

## 💡 Workflow Tips

- For longer books, consider generating chapters in batches using the `--generate-chapters` command
- If API rate limits are reached, wait and then continue with `--generate-chapters` from the last completed chapter
- The `--enhance` command can be run separately after all chapters are generated
- For quick previews, use `--pdf` to compile chapters without waiting for the enhancement phase

## 🤝 Contributing

Contributions are welcome! Areas for improvement:
- Additional genre-specific prompting
- Enhanced PDF formatting
- Word count target controls
- Cover image generation
- EPUB/MOBI conversion
- Multi-model support for different LLMs

## 📜 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Built using the Groq API
- PDF generation using pdf-lib
- Special thanks to all contributors and testers