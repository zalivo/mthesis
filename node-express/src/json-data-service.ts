import fs from 'fs/promises';
import path from 'path';

// Define types for our sculpture data
export interface Sculpture {
    name: string;
    year?: string;
    location?: string;
    artist?: string;
    cast_information?: string;
    original_material?: string;
    dimensions?: string;
    description?: string;
    style?: string;
    artifacts?: string[];
    original_information?: string;
}

interface GeneralInfo {
    title: string;
    description: string;
}

export interface SculptureData {
    general_information: {
        gallery_collection: GeneralInfo;
        gothic_style: GeneralInfo;
    };
    sculptures: Sculpture[];
}

export class JsonDataService {
    private data: SculptureData | null = null;
    private dataPath: string;

    constructor(dataPath: string) {
        this.dataPath = dataPath;
    }

    // Getter for sculptures array
    get sculptures(): Sculpture[] {
        return this.data?.sculptures || [];
    }

    async loadData(): Promise<boolean> {
        try {
            const fileContent = await fs.readFile(this.dataPath, 'utf-8');
            this.data = JSON.parse(fileContent);
            return true;
        } catch (error) {
            console.error('Error loading sculpture data:', error);
            return false;
        }
    }

    // Find a sculpture by exact name match first, then fall back to partial match
    async findSculptureByName(name: string): Promise<Sculpture[]> {
        if (!this.data) await this.loadData();
        if (!this.data) return [];

        const searchName = name.toLowerCase().trim();
        
        // Try exact match first (case insensitive)
        const exactMatches = this.data.sculptures.filter(
            sculpture => sculpture.name.toLowerCase() === searchName
        );
        if (exactMatches.length > 0) return exactMatches;

        // Try normalized name match (removing special characters)
        const normalizedSearch = this.normalizeName(searchName);
        const normalizedMatches = this.data.sculptures.filter(
            sculpture => this.normalizeName(sculpture.name) === normalizedSearch
        );
        if (normalizedMatches.length > 0) return normalizedMatches;

        // Fall back to partial matches, sorted by closest match length
        return this.data.sculptures
            .filter(sculpture => sculpture.name.toLowerCase().includes(searchName))
            .sort((a, b) => b.name.length - a.name.length);
    }

    // Get details about a specific sculpture by name - strict matching
    async getSculptureByName(name: string): Promise<Sculpture | null> {
        const matches = await this.findSculptureByName(name);
        return matches.length > 0 ? matches[0] : null;
    }

    // Search sculptures by multiple criteria with improved matching
    async searchSculptures(params: {
        name?: string;
        artist?: string;
        location?: string;
        year?: string;
    }): Promise<Sculpture[]> {
        if (!this.data) await this.loadData();
        if (!this.data) return [];

        // If no search parameters provided, return empty array
        if (!params.name && !params.artist && !params.location && !params.year) {
            return [];
        }

        return this.data.sculptures.filter(sculpture => {
            if (params.name) {
                const searchName = params.name.toLowerCase().trim();
                const sculptureName = sculpture.name.toLowerCase();
                if (!sculptureName.includes(searchName)) {
                    return false;
                }
            }

            if (params.artist && sculpture.artist) {
                const searchArtist = params.artist.toLowerCase().trim();
                const sculptureArtist = sculpture.artist.toLowerCase();
                if (!sculptureArtist.includes(searchArtist)) {
                    return false;
                }
            }

            if (params.location && sculpture.location) {
                const searchLocation = params.location.toLowerCase().trim();
                const sculptureLocation = sculpture.location.toLowerCase();
                if (!sculptureLocation.includes(searchLocation)) {
                    return false;
                }
            }

            if (params.year && sculpture.year) {
                const searchYear = params.year.toLowerCase().trim();
                const sculptureYear = sculpture.year.toLowerCase();
                if (!sculptureYear.includes(searchYear)) {
                    return false;
                }
            }

            return true;
        });
    }

    // Get general information about the gallery collection
    async getGalleryInfo(): Promise<GeneralInfo | null> {
        if (!this.data) await this.loadData();
        return this.data?.general_information?.gallery_collection || null;
    }

    // Get general information about Gothic style
    async getGothicStyleInfo(): Promise<GeneralInfo | null> {
        if (!this.data) await this.loadData();
        return this.data?.general_information?.gothic_style || null;
    }

    private normalizeName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^\w\s]/g, '') // Remove special characters
            .replace(/\s+/g, ' ')    // Normalize whitespace
            .trim();
    }
}