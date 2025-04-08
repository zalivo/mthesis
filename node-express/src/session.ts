import { WebSocket } from "ws";
import {
  RTClient,
  RTResponse,
  RTInputAudioItem,
  RTTextContent,
  RTAudioContent,
} from "rt-client";
import { DefaultAzureCredential } from "@azure/identity";
import { AzureKeyCredential } from "@azure/core-auth";
import { Logger } from "pino";
import { JsonDataService } from "./json-data-service.js";
import path from "path";

interface TextDelta {
  id: string;
  type: "text_delta";
  delta: string;
}

interface Transcription {
  id: string;
  type: "transcription";
  text: string;
}

interface UserMessage {
  id: string;
  type: "user_message";
  text: string;
}

interface SpeechStarted {
  type: "control";
  action: "speech_started";
}

interface Connected {
  type: "control";
  action: "connected";
  greeting: string;
}

interface TextDone {
  type: "control";
  action: "text_done";
  id: string;
}

type ControlMessage = SpeechStarted | Connected | TextDone;

type WSMessage = TextDelta | Transcription | UserMessage | ControlMessage;

export class RTSession {
  private client: RTClient;
  private ws: WebSocket;
  private readonly sessionId: string;
  private logger: Logger;
  private dataService: JsonDataService | null = null;

  constructor(ws: WebSocket, backend: string | undefined, logger: Logger) {
    this.sessionId = crypto.randomUUID();
    this.ws = ws;
    this.logger = logger.child({ sessionId: this.sessionId });
    this.client = this.initializeClient(backend);
    this.setupEventHandlers();
    this.initializeDataService();
    this.logger.info("New session created");
    this.initialize();
    process.on("unhandledRejection", (reason) => {
      this.logger.error({ reason }, "Unhandled promise rejection");
    });
  }

  private async initializeDataService() {
    try {
      // Path to the JSON data file
      const dataPath = path.resolve(process.cwd(), process.env.SCULPTURE_DATA_PATH || "data/sculptures.json");

      this.dataService = new JsonDataService(dataPath);
      const loaded = await this.dataService.loadData();

      if (loaded) {
        this.logger.info(`Successfully loaded sculpture data from ${dataPath}`);
      } else {
        this.logger.error(`Failed to load sculpture data from ${dataPath}`);
        this.dataService = null;
      }
    } catch (error) {
      this.logger.error({ error }, "Error initializing data service");
      this.dataService = null;
    }
  }

  async initialize() {
    this.logger.debug("Configuring realtime session");
    await this.client.configure({
      modalities: ["text", "audio"],
      input_audio_format: "pcm16",
      input_audio_transcription: {
        model: "whisper-1",
      },
      voice: "verse",
      turn_detection: {
        type: "server_vad",
      },
    });

    this.logger.debug("Realtime session configured successfully");
    /* Send greeting */
    const greeting: Connected = {
      type: "control",
      action: "connected",
      greeting: "Hey there! I'm a guide in the National Gallery in Prague. Feel free to ask my anything that comes to your mind.",
    };
    this.send(greeting);
    this.logger.debug("Realtime session configured successfully");
    this.startEventLoop();
  }

  private send(message: WSMessage) {
    this.ws.send(JSON.stringify(message));
  }

  private sendBinary(message: ArrayBuffer) {
    this.ws.send(Buffer.from(message), { binary: true });
  }

  private initializeClient(backend: string | undefined): RTClient {
    this.logger.debug({ backend }, "Initializing RT client");

    if (backend === "azure") {
      //let auth = new DefaultAzureCredential();
      let auth = new AzureKeyCredential(process.env.AZURE_OPENAI_API_KEY!);

      return new RTClient(
        new URL(process.env.AZURE_OPENAI_ENDPOINT!),
        auth,
        { deployment: process.env.AZURE_OPENAI_DEPLOYMENT! },
      );
    }
    return new RTClient(new AzureKeyCredential(process.env.OPENAI_API_KEY!), {
      model: process.env.OPENAI_MODEL!,
    });
  }

  private setupEventHandlers() {
    this.logger.debug("Client configured successfully");

    this.ws.on("message", this.handleMessage.bind(this));
    this.ws.on("close", this.handleClose.bind(this));
    this.ws.on("error", (error) => {
      this.logger.error({ error }, "WebSocket error occurred");
    });
  }

  private async handleMessage(message: Buffer, isBinary: boolean) {
    try {
      if (isBinary) {
        await this.handleBinaryMessage(message);
      } else {
        await this.handleTextMessage(message);
      }
    } catch (error) {
      this.logger.error({ error }, "Error handling message");
    }
  }

  private async handleBinaryMessage(message: Buffer) {
    try {
      await this.client.sendAudio(new Uint8Array(message));
    } catch (error) {
      this.logger.error({ error }, "Failed to send audio data");
      throw error;
    }
  }

  private async handleTextMessage(message: Buffer) {
    const messageString = message.toString("utf-8");
    const parsed: WSMessage = JSON.parse(messageString);
    this.logger.debug({ messageType: parsed.type }, "Received text message");

    if (parsed.type === "user_message") {
      try {
        // Extract potential sculpture-related info from the message if we have data service
        if (this.dataService && parsed.text) {
          await this.enrichWithSculptureData(parsed.text);
        }

        await this.client.sendItem({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: parsed.text }],
        });
        await this.client.generateResponse();
        this.logger.debug("User message processed successfully");
      } catch (error) {
        this.logger.error({ error }, "Failed to process user message");
        throw error;
      }
    }
  }

  private async enrichWithSculptureData(userMessage: string) {
    if (!this.dataService) return;

    try {
      // Extract potential sculpture names from the message
      const potentialNames = this.dataService.sculptures.map(s => s.name).filter(name => 
        userMessage.toLowerCase().includes(name.toLowerCase())
      );

      if (potentialNames.length > 0) {
        // Get the longest matching name (to avoid partial matches taking precedence)
        const bestMatch = potentialNames.sort((a, b) => b.length - a.length)[0];
        const sculpture = await this.dataService.getSculptureByName(bestMatch);
        
        if (sculpture) {
          const contextMessage = this.formatSculptureInfo([sculpture]);
          await this.client.sendItem({
            type: "message",
            role: "system",
            content: [{ 
              type: "input_text", 
              text: `I found information about "${sculpture.name}" in our collection. Here are the details:\n${contextMessage}\n\nPlease provide this information to the user in a friendly, engaging way, focusing on the most relevant aspects to their question.` 
            }],
          });
          return;
        }
      }

      // If no exact matches, try broader search
      const words = userMessage.toLowerCase().split(/\s+/);
      const results = await this.dataService.searchSculptures({
        name: words.join(" "),
        artist: words.join(" "),
        location: words.join(" "),
        year: words.join(" ")
      });
      
      if (results && results.length > 0) {
        const contextMessage = this.formatSculptureInfo(results);
        await this.client.sendItem({
          type: "message",
          role: "system",
          content: [{ 
            type: "input_text", 
            text: `I found some relevant sculptures in our collection that might interest the user:\n${contextMessage}\n\nPlease use this information to provide a helpful, engaging response focused on the most relevant aspects to their question.` 
          }],
        });
      }
    } catch (error) {
      this.logger.error({ error }, "Error enriching message with sculpture data");
    }
  }

  private formatSculptureInfo(sculptures: any[]): string {
    return sculptures.map(sculpture => {
      const info = [`Name: ${sculpture.name}`];
      if (sculpture.year) info.push(`Year: ${sculpture.year}`);
      if (sculpture.location) info.push(`Location: ${sculpture.location}`);
      if (sculpture.artist) info.push(`Artist: ${sculpture.artist}`);
      if (sculpture.description) info.push(`Description: ${sculpture.description}`);
      if (sculpture.cast_information) info.push(`Cast Information: ${sculpture.cast_information}`);
      if (sculpture.original_material) info.push(`Original Material: ${sculpture.original_material}`);
      if (sculpture.dimensions) info.push(`Dimensions: ${sculpture.dimensions}`);
      return info.join('\n');
    }).join('\n\n');
  }

  private extractSculptureTerms(userMessage: string): string[] {
    if (!this.dataService) return [];
    const message = userMessage.toLowerCase();
    const sculptures = this.dataService.searchSculptures({ name: message });
    return sculptures.map(sculpture => sculpture.name);
  }

  private extractArtistTerms(userMessage: string): string[] {
    if (!this.dataService) return [];
    const message = userMessage.toLowerCase();
    const sculptures = this.dataService.searchSculptures({ artist: message });
    return sculptures
      .filter(sculpture => sculpture.artist)
      .map(sculpture => sculpture.artist!);
  }

  private async handleClose() {
    this.logger.info("Session closing");
    try {
      await this.client.close();
      this.logger.info("Session closed successfully");
    } catch (error) {
      this.logger.error({ error }, "Error closing session");
    }
  }

  private async handleTextContent(content: RTTextContent) {
    try {
      const contentId = `${content.itemId}-${content.contentIndex}`;
      for await (const text of content.textChunks()) {
        const deltaMessage: TextDelta = {
          id: contentId,
          type: "text_delta",
          delta: text,
        };
        this.send(deltaMessage);
      }
      this.send({ type: "control", action: "text_done", id: contentId });
      this.logger.debug("Text content processed successfully");
    } catch (error) {
      this.logger.error({ error }, "Error handling text content");
      throw error;
    }
  }

  private async handleAudioContent(content: RTAudioContent) {
    const handleAudioChunks = async () => {
      for await (const chunk of content.audioChunks()) {
        this.sendBinary(chunk.buffer instanceof ArrayBuffer ? chunk.buffer : new ArrayBuffer(chunk.buffer.byteLength).slice(0));
      }
    };

    const handleAudioTranscript = async () => {
      const contentId = `${content.itemId}-${content.contentIndex}`;
      for await (const chunk of content.transcriptChunks()) {
        this.send({ id: contentId, type: "text_delta", delta: chunk });
      }
      this.send({ type: "control", action: "text_done", id: contentId });
    };

    try {
      await Promise.all([handleAudioChunks(), handleAudioTranscript()]);
      this.logger.debug("Audio content processed successfully");
    } catch (error) {
      this.logger.error({ error }, "Error handling audio content");
      throw error;
    }
  }

  private async handleResponse(event: RTResponse) {
    try {
      for await (const item of event) {
        if (item.type === "message") {
          for await (const content of item) {
            if (content.type === "text") {
              await this.handleTextContent(content);
            } else if (content.type === "audio") {
              await this.handleAudioContent(content);
            }
          }
        }
      }
      this.logger.debug("Response handled successfully");
    } catch (error) {
      this.logger.error({ error }, "Error handling response");
      throw error;
    }
  }

  private async handleInputAudio(event: RTInputAudioItem) {
    try {
      this.send({ type: "control", action: "speech_started" });
      await event.waitForCompletion();
      const transcription: Transcription = {
        id: event.id,
        type: "transcription",
        text: event.transcription || "",
      };
      this.send(transcription);
      this.logger.debug(
        { transcriptionLength: transcription.text.length },
        "Input audio processed successfully",
      );
    } catch (error) {
      this.logger.error({ error }, "Error handling input audio");
      throw error;
    }
  }

  private async startEventLoop() {
    // Set up the agent with system message about sculptures
    await this.client.sendItem({
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: `You are a gallery guide helping visually impaired explore tactile artworks located in the National Gallery in Prague. The people you talk with have direct access to the artworks so your goal is to help them in their exploration. You have access to a detailed database of sculptures including:

1. Tympanum of the northern portal of the Church of Our Lady before Týn - A dramatic religious relief from around 1380
2. Charles the fourth - A remarkable royal bust from St. Vitus Ironworks
3. Anna of Schweidnitz - A beautiful portrait bust from St. Vitus Ironworks
4. Votive relief from the Basilica of St. George - A historic religious artwork from before 1228

When asked about these specific sculptures, use ONLY the information provided in the database. If asked about other sculptures or general art topics, clearly indicate when you're speaking from general knowledge rather than our specific collection.

Maintain a warm, engaging tone and focus on making art accessible and interesting for everyone. When describing sculptures, focus on the details provided in our database, including year, location, materials, dimensions, and the detailed descriptions provided.`
        }
      ]
    });

    // Desribing artwork
    this.client.sendItem(
      {
        type: "message", 
        role: "system", 
        content: [
          { 
            type: "input_text", 
            text: "If you are asked to describe an artwork, your answer should follow this template: Begin with a concise description of the painting. Focus on a reasoning process—why certain elements are prominent or meaningful in the artwork. Use vivid, sensory-rich language to help the user visualize or feel the scene. Describe the layout of the painting, logically guiding the user through the scene from one section to another. Mention how elements interact, considering balance, contrast, or composition techniques used by the artist. Move on to a discussion of the painting’s themes and deeper meanings. Reflect on how the painting’s style, colors, and objects contribute to the overall message or emotional experience." 
          },
        ]
      }
    );

    // How answers should be structured
    this.client.sendItem(
      {
        type: "message", 
        role: "system", 
        content: [
          { 
            type: "input_text", 
            text: "Avoid overwhelming the user with too much detail in one response; focus on developing their understanding step by step. Use only the information you are provided. If you are saying something that is not included in the data you are provided with, say it and acknowledge it." 
          },
        ]
      }
    );
    
    // Add context about the sculpture database capabilities
    this.client.sendItem(
      {
        type: "message", 
        role: "system", 
        content: [
          { 
            type: "input_text", 
            text: "The database contains detailed information about medieval sculptures, including their historical context, materials, dimensions, and detailed descriptions. When discussing any sculpture, focus on the specific information provided in our database - including the cast information, original materials, dimensions, and historical descriptions. Share this information with enthusiasm and help users understand the historical and artistic significance of each piece. Respond as if you're giving a personal, engaging tour through a medieval art collection - knowledgeable but approachable and engaging." 
          },
        ]
      }
    );

    try {
      this.logger.debug("Starting event loop");
      for await (const event of this.client.events()) {
        if (event.type === "response") {
          await this.handleResponse(event);
        } else if (event.type === "input_audio") {
          await this.handleInputAudio(event);
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Error in event loop");
      throw error;
    }
  }
}
