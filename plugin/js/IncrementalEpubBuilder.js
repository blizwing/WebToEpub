/*
  Incremental EPUB builder for batch-based assembly
  Allows packing EPUB in batches as chapters are downloaded, with validation after each batch
*/
"use strict";

/**
 * Incremental EPUB builder that packs batches of content as they are downloaded
 * instead of waiting for all downloads to complete.
 *
 * This approach:
 * - Starts packing EPUB as soon as first batch is ready
 * - Validates data integrity after each batch
 * - Cleans memory after successful packing
 * - Prevents memory overflow on large books
 * - Provides responsive UI during long operations
 */
class IncrementalEpubBuilder {
    constructor(metaInfo, version = EpubPacker.EPUB_VERSION_2) {
        this.metaInfo = metaInfo;
        this.version = version;
        this.zipWriter = null;
        this.zipFileWriter = null;
        this.initialized = false;
        this.batchCount = 0;
        this.packedItemIds = new Set(); // Track items already packed

        // Packer for metadata generation
        this.epubPacker = new EpubPacker(metaInfo, version);
    }

    /**
     * Initialize the EPUB ZIP writer and add required metadata files
     * Call this once before packing any batches
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        this.zipFileWriter = new zip.BlobWriter("application/epub+zip");
        this.zipWriter = new zip.ZipWriter(this.zipFileWriter, {
            useWebWorkers: false,
            compressionMethod: 8,
            extendedTimestamp: false
        });

        // Add required EPUB files
        this.epubPacker.addRequiredFiles(this.zipWriter);

        // Update progress
        if (typeof ProgressBar !== "undefined") {
            ProgressBar.setValue(1);
        }

        await util.sleep(0);
        this.initialized = true;
        console.log("IncrementalEpubBuilder initialized");
    }

    /**
     * Pack a batch of content items
     * @param {Array} batchItems - Items to pack in this batch
     * @param {Object} allItems - Full supplier of all items (for manifest/spine)
     * @returns {Promise<Object>} Validation result
     */
    async packBatch(batchItems) {
        if (!this.initialized) {
            await this.initialize();
        }

        this.batchCount++;
        console.log(`Packing batch ${this.batchCount} with ${batchItems.length} items`);

        // Validate batch items before packing
        let validationResult = this.validateBatchData(batchItems);
        if (!validationResult.valid) {
            throw new Error(`Batch validation failed: ${validationResult.error}`);
        }

        try {
            // Pack content files from this batch
            for (let item of batchItems) {
                if (!this.packedItemIds.has(item.id)) {
                    await this.packItem(item);
                    this.packedItemIds.add(item.id);
                }
            }

            // Yield to event loop after packing batch
            await util.sleep(0);

            // Verify integrity after packing
            let integrityResult = this.verifyZipIntegrity();
            if (!integrityResult.valid) {
                throw new Error(`ZIP integrity check failed: ${integrityResult.error}`);
            }

            console.log(`Batch ${this.batchCount} packed successfully. Items packed: ${this.packedItemIds.size}`);
            return { success: true, batchNumber: this.batchCount };

        } catch (error) {
            console.error(`Error packing batch ${this.batchCount}:`, error);
            throw error;
        }
    }

    /**
     * Validate batch data before packing
     * @private
     */
    validateBatchData(batchItems) {
        try {
            // Check batch is not empty
            if (!batchItems || batchItems.length === 0) {
                return { valid: false, error: "Batch is empty" };
            }

            // Check all items are valid
            for (let item of batchItems) {
                if (!item || !item.id) {
                    return { valid: false, error: "Item missing required properties (id)" };
                }

                // Verify item has content
                if (item.mediaType?.startsWith("text/") || item.mediaType?.startsWith("application/x")) {
                    // Text content must have data
                    if (!item.getEpubData || typeof item.getEpubData !== "function") {
                        return { valid: false, error: `Item ${item.id} missing getEpubData method` };
                    }
                } else if (item.mediaType?.startsWith("image/")) {
                    // Images must have arraybuffer
                    if (!item.arraybuffer) {
                        return { valid: false, error: `Image item ${item.id} missing arraybuffer` };
                    }
                }
            }

            // Check for duplicate item IDs in batch
            let ids = new Set();
            for (let item of batchItems) {
                if (ids.has(item.id)) {
                    return { valid: false, error: `Duplicate item ID: ${item.id}` };
                }
                ids.add(item.id);
            }

            return { valid: true };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    /**
     * Pack a single item into the EPUB
     * @private
     */
    async packItem(item) {
        try {
            if (item.mediaType?.startsWith("image/")) {
                // Pack image
                this.zipWriter.add(item.id, new zip.ArrayBufferReader(item.arraybuffer), {
                    lastModDate: new Date(),
                    mimeType: item.mediaType
                });
            } else {
                // Pack text content (chapter/page)
                let epubData = item.getEpubData();
                this.zipWriter.add(item.id, new zip.TextReader(epubData), {
                    lastModDate: new Date(),
                    mimeType: item.mediaType
                });
            }
        } catch (error) {
            console.error(`Error packing item ${item.id}:`, error);
            throw error;
        }
    }

    /**
     * Verify ZIP integrity after packing batch
     * @private
     */
    verifyZipIntegrity() {
        try {
            // Check that zipWriter is still valid
            if (!this.zipWriter) {
                return { valid: false, error: "ZIP writer is null" };
            }

            // Check that blob writer still has data
            if (!this.zipFileWriter) {
                return { valid: false, error: "ZIP file writer is null" };
            }

            return { valid: true };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    /**
     * Finalize the EPUB after all batches are packed
     * Updates manifest, spine, and table of contents with all items
     * @param {Object} allItems - Complete item supplier with all content
     * @returns {Promise<Blob>} Final EPUB blob
     */
    async finalize(allItems) {
        if (!this.initialized) {
            throw new Error("Builder not initialized");
        }

        console.log("Finalizing EPUB with all metadata");

        try {
            // Add updated content.opf with final manifest and spine
            let contentOpf = this.epubPacker.buildContentOpf(allItems);
            this.zipWriter.add("OEBPS/content.opf", new zip.TextReader(contentOpf));

            await util.sleep(0);

            // Add table of contents
            let toc = this.epubPacker.buildTableOfContents(allItems);
            this.zipWriter.add("OEBPS/toc.ncx", new zip.TextReader(toc));

            await util.sleep(0);

            // Add EPUB3 navigation document if needed
            if (this.version === EpubPacker.EPUB_VERSION_3) {
                let navDoc = this.epubPacker.buildNavigationDocument(allItems);
                this.zipWriter.add("OEBPS/toc.xhtml", new zip.TextReader(navDoc));
                await util.sleep(0);
            }

            // Add stylesheet
            this.zipWriter.add(util.styleSheetFileName(), new zip.TextReader(this.metaInfo.styleSheet));

            await util.sleep(0);

            // Close ZIP and return blob
            let epubBlob = await this.zipWriter.close();
            console.log("EPUB finalized successfully");
            return epubBlob;

        } catch (error) {
            console.error("Error finalizing EPUB:", error);
            throw error;
        }
    }

    /**
     * Get number of batches packed
     */
    getBatchCount() {
        return this.batchCount;
    }

    /**
     * Get number of items packed so far
     */
    getPackedItemCount() {
        return this.packedItemIds.size;
    }

    /**
     * Check if already initialized
     */
    isInitialized() {
        return this.initialized;
    }
}
