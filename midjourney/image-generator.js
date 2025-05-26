// midjourney/image-generator.js (FIXED VERSION - Correct Image URL Syntax)
const MidjourneyClient = require('./midjourney-client');
const promptFilter = require('./prompt-filter'); 
const { getOne, getAll, runQuery } = require('../db');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

/**
 * Generate prompt from recipe data - FIXED: Correct Midjourney image URL syntax
 * @param {Object} recipe - Recipe data
 * @param {string} imageUrl - Optional image URL for reference
 * @returns {string} Generated prompt
 */
function generatePrompt(recipe, imageUrl = null) {
  // Use recipe_idea instead of title
  const recipeIdea = recipe.recipe_idea || '';
  
  // Extract ingredients if available (limit to first 3 main ingredients)
  let ingredients = '';
  try {
    if (recipe.ingredients) {
      // Try parsing as JSON if it's stored that way
      const ingredientsData = typeof recipe.ingredients === 'string' 
        ? JSON.parse(recipe.ingredients) 
        : recipe.ingredients;
      
      if (Array.isArray(ingredientsData)) {
        ingredients = ingredientsData
          .slice(0, 3)
          .map(ing => typeof ing === 'string' ? ing : ing.name || ing.ingredient || '')
          .filter(ing => ing)
          .join(', ');
      } else if (typeof recipe.ingredients === 'string') {
        // If it's a plain string, use the first part
        ingredients = recipe.ingredients.split(',').slice(0, 3).join(', ');
      }
    }
  } catch (error) {
    // If JSON parsing fails, try using it as a string
    if (typeof recipe.ingredients === 'string') {
      ingredients = recipe.ingredients.split(',').slice(0, 3).join(', ');
    }
    console.error('Error parsing ingredients:', error.message);
  }
  
  // Create the core prompt with the recipe idea
  let prompt = `Professional food photography of ${recipeIdea}`;
  
  // Add ingredients if available
  if (ingredients) {
    prompt += `, with ${ingredients} visible`;
  }
  
  // Add styling details for better food photography
  prompt += ", on a beautiful plate, soft natural lighting, shallow depth of field, high-end restaurant presentation, professional food photography, 4k, detailed, award-winning food photography";
  
  // FIXED: Correct Midjourney syntax for image URLs
  // Image URL should go at the BEGINNING, not at the end with --seed
  if (imageUrl && imageUrl.trim()) {
    console.log(`🖼️ [PROMPT] Adding reference image URL: ${imageUrl.trim()}`);
    // Put image URL at the start, followed by the prompt, then image weight parameter
    prompt = `${imageUrl.trim()} ${prompt} --iw 0.75`;
    console.log(`🖼️ [PROMPT] Final prompt with image: ${prompt}`);
  }
  
  return prompt;
}

/**
 * Filter and sanitize prompt for Midjourney safety
 * @param {string} originalPrompt - Original prompt text
 * @param {Object} options - Filtering options
 * @returns {Object} Filter result with success status and filtered prompt
 */
function filterPromptForMidjourney(originalPrompt, options = {}) {
  try {
    console.log('🔍 [FILTER] Original prompt:', originalPrompt);
    
    const filterResult = promptFilter.filterPrompt(originalPrompt, {
      strictMode: true,
      context: 'photography', // Food photography context
      allowReplacements: true,
      logChanges: true,
      ...options
    });
    
    if (!filterResult.success) {
      console.error('❌ [FILTER] Prompt filtering failed:', filterResult.error);
      return {
        success: false,
        error: filterResult.error,
        originalPrompt: originalPrompt,
        filteredPrompt: null,
        changes: filterResult.changes || [],
        warnings: filterResult.warnings || []
      };
    }
    
    if (filterResult.changes.length > 0) {
      console.log('✅ [FILTER] Prompt successfully filtered with', filterResult.changes.length, 'changes');
      console.log('📝 [FILTER] Filtered prompt:', filterResult.filteredPrompt);
    } else {
      console.log('✅ [FILTER] Prompt passed without changes needed');
    }
    
    return {
      success: true,
      originalPrompt: originalPrompt,
      filteredPrompt: filterResult.filteredPrompt,
      changes: filterResult.changes,
      warnings: filterResult.warnings || []
    };
    
  } catch (error) {
    console.error('💥 [FILTER] Error during prompt filtering:', error);
    return {
      success: false,
      error: 'Prompt filtering system error: ' + error.message,
      originalPrompt: originalPrompt,
      filteredPrompt: originalPrompt, // Use original as fallback
      changes: [],
      warnings: []
    };
  }
}

/**
 * FIXED: Helper function to add image URL to existing prompt with correct syntax
 * @param {string} existingPrompt - The existing prompt text
 * @param {string} imageUrl - The image URL to add
 * @returns {string} Updated prompt with correct image URL syntax
 */
function addImageUrlToPrompt(existingPrompt, imageUrl) {
  if (!imageUrl || !imageUrl.trim()) {
    return existingPrompt;
  }
  
  const cleanImageUrl = imageUrl.trim();
  
  // Check if image URL is already in the prompt (at the beginning)
  if (existingPrompt.startsWith(cleanImageUrl)) {
    console.log('🖼️ [PROMPT] Image URL already present in prompt');
    return existingPrompt;
  }
  
  // Check if prompt already has an image URL at the beginning (starts with http)
  if (existingPrompt.startsWith('http')) {
    console.log('🖼️ [PROMPT] Prompt already has an image URL, replacing it');
    // Find the end of the existing URL (first space after http)
    const firstSpaceIndex = existingPrompt.indexOf(' ');
    if (firstSpaceIndex > 0) {
      const restOfPrompt = existingPrompt.substring(firstSpaceIndex + 1);
      return `${cleanImageUrl} ${restOfPrompt}`;
    }
  }
  
  // Add image URL to the beginning with correct syntax
  console.log(`🖼️ [PROMPT] Adding image URL to beginning of prompt: ${cleanImageUrl}`);
  
  // Remove any existing --iw parameter to avoid duplication
  let cleanPrompt = existingPrompt.replace(/--iw\s+[\d.]+/g, '').trim();
  
  // Add image URL at the beginning with image weight parameter
  return `${cleanImageUrl} ${cleanPrompt} --iw 0.75`;
}

/**
 * ENHANCED: Generate image for recipe with Discord settings support - FIXED IMAGE URL HANDLING
 * @param {integer} recipeId - Recipe ID
 * @param {Object} discordSettings - Discord settings object
 * @returns {Object} Result with status and image information
 */
async function generateImageForRecipeWithSettings(recipeId, discordSettings = null) {
  console.log(`🎨 Starting image generation with Discord settings for recipe ID: ${recipeId}`);
  
  let imageId = null;
  
  try {
    // Get recipe data from the database
    const recipe = await getOne("SELECT * FROM recipes WHERE id = ?", [recipeId]);
    
    if (!recipe) {
      throw new Error(`Recipe not found with ID: ${recipeId}`);
    }
    
    console.log(`Found recipe: ${recipe.recipe_idea}`);
    
    // Check if the recipe already has a generated image
    const existingImage = await getOne(
      "SELECT * FROM recipe_images WHERE recipe_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
      [recipeId]
    );
    
    // If image exists, return it
    if (existingImage) {
      console.log(`Recipe ${recipeId} already has an image: ${existingImage.image_path}`);
      return {
        id: existingImage.id,
        imagePath: existingImage.image_path,
        success: true,
        existing: true
      };
    }
    
    const keyword = await getOne(
  "SELECT * FROM keywords WHERE recipe_id = ? ORDER BY added_at DESC LIMIT 1", 
  [recipeId]
);
    
    const imageUrl = keyword && keyword.image_url ? keyword.image_url : null;
    if (imageUrl) {
      console.log(`🖼️ [IMAGE-URL] Found reference image URL for recipe ${recipeId}: ${imageUrl}`);
    } else {
      console.log(`🖼️ [IMAGE-URL] No reference image URL found for recipe ${recipeId}`);
    }
    
    // Get the facebook_content record for this recipe to use existing prompt if available
    const facebookContent = await getOne(
      "SELECT * FROM facebook_content WHERE recipe_id = ? ORDER BY id DESC LIMIT 1",
      [recipeId]
    );
    
    // Initialize prompt variable
    let originalPrompt = '';
    
    // Check if we have facebook_content and it has an mj_prompt field
    if (facebookContent && facebookContent.mj_prompt) {
      // Use existing prompt
      originalPrompt = facebookContent.mj_prompt;
      console.log('🔄 [PROMPT] Using existing mj_prompt from facebook_content table');
      console.log('🔍 [PROMPT] Original prompt from DB:', originalPrompt);
      
      // FIXED: Add image URL with correct syntax if we have one
      if (imageUrl) {
        originalPrompt = addImageUrlToPrompt(originalPrompt, imageUrl);
        console.log('🖼️ [PROMPT] Added reference image URL to existing prompt');
        console.log('🔍 [PROMPT] Updated prompt with image:', originalPrompt);
      }
    } else {
      // If no prompt found, generate a new one with image URL included if available
      console.log('🆕 [PROMPT] No existing prompt found, generating new one');
      originalPrompt = generatePrompt(recipe, imageUrl);
      console.log('🔍 [PROMPT] Generated new prompt:', originalPrompt);
    }
    
    console.log(`🎯 [FINAL] Final prompt with image reference: ${originalPrompt}`);
    
    // Filter the prompt before sending to Midjourney
    const filterResult = filterPromptForMidjourney(originalPrompt);
    
    if (!filterResult.success) {
      // Prompt filtering failed - this is a critical safety issue
      console.error(`❌ Prompt filtering failed for recipe ${recipeId}: ${filterResult.error}`);
      
      // Save the failed attempt to database
      const recordId = uuidv4();
      const result = await runQuery(
        "INSERT INTO recipe_images (id, recipe_id, prompt, image_path, status, error) VALUES (?, ?, ?, ?, ?, ?)",
        [recordId, recipeId, originalPrompt, '', 'failed', filterResult.error]
      );
      
      return {
        id: recordId,
        error: `Prompt contains prohibited content: ${filterResult.error}`,
        success: false,
        filterResult: filterResult
      };
    }
    
    // Use the filtered prompt
    const finalPrompt = filterResult.filteredPrompt;
    
    // Log filtering results if changes were made
    if (filterResult.changes.length > 0) {
      console.log(`✅ Prompt filtered for recipe ${recipeId}:`);
      filterResult.changes.forEach((change, index) => {
        console.log(`   ${index + 1}. "${change.original}" → "${change.replacement}" (${change.reason})`);
      });
    }
    
    // Create entry in database with 'pending' status and generate UUID
    console.log('📝 Creating database record...');
    
    // Generate a UUID for the record (since your table uses UUIDs)
    const recordId = uuidv4();
    
    const result = await runQuery(
      "INSERT INTO recipe_images (id, recipe_id, prompt, image_path, status, filter_changes) VALUES (?, ?, ?, ?, ?, ?)",
      [recordId, recipeId, finalPrompt, '', 'pending', JSON.stringify(filterResult.changes)]
    );
    
    // Use the UUID we generated, not result.lastID
    imageId = recordId;
    console.log(`✅ Created recipe_images record with UUID: ${imageId}`);
    
    // Verify the record was created correctly
    const verifyCreation = await getOne(
      "SELECT id, recipe_id, status FROM recipe_images WHERE id = ?",
      [imageId]
    );
    
    if (!verifyCreation) {
      throw new Error(`Failed to create database record with ID ${imageId}`);
    }
    
    console.log('✅ Record creation verified:', {
      id: verifyCreation.id,
      recipe_id: verifyCreation.recipe_id,
      status: verifyCreation.status
    });
    
    // ADD: Random delay before starting (human-like)
    const initialDelay = Math.random() * 3000 + 2000; // 2-5 seconds
    console.log(`⏳ Waiting ${Math.round(initialDelay/1000)}s before starting...`);
    await new Promise(resolve => setTimeout(resolve, initialDelay));
    
    // Reset any existing instance to ensure fresh settings
    MidjourneyClient.resetInstance();
    
    // Get client with Discord settings
    const client = MidjourneyClient.getInstance(discordSettings);
    
    console.log(`Generating image for recipe ${recipeId} with filtered prompt: ${finalPrompt}`);
    
    // Update status to 'generating' before calling Midjourney
    console.log(`🔄 Updating status to 'generating' for record: ${imageId}`);
    
    await runQuery(
      "UPDATE recipe_images SET status = ? WHERE id = ?",
      ['generating', imageId]
    );
    
    // Verify the status update
    const verifyGenerating = await getOne(
      "SELECT id, status FROM recipe_images WHERE id = ?",
      [imageId]
    );
    
    console.log('✅ Status updated to generating:', {
      id: verifyGenerating.id,
      status: verifyGenerating.status
    });
    
    console.log(`Updated status to 'generating' for image ID: ${imageId}`);
    
    // ENHANCED: Debug logging before sending to Midjourney
    console.log('🔍 [PRE-MIDJOURNEY DEBUG] About to send to Midjourney:');
    console.log('   Final prompt:', finalPrompt);
    console.log('   Prompt length:', finalPrompt.length);
    console.log('   Starts with image URL?', finalPrompt.startsWith('http'));
    console.log('   Contains --iw?', finalPrompt.includes('--iw'));
    console.log('   First 200 chars:', finalPrompt.substring(0, 200));

    // Use the createImage method WITHOUT upscaling (upscaleIndex = null)
    const mjResult = await client.createImage(finalPrompt, '--v 5 --q 2', null);
    console.log('🔍 Midjourney result received:', {
      hasResult: !!mjResult,
      hasUpscaledUrl: !!(mjResult && mjResult.upscaled_photo_url),
      hasGridInfo: !!(mjResult && mjResult.grid_info),
      messageId: mjResult ? mjResult.imagine_message_id : null
    });
    
    if (!mjResult) {
      throw new Error('No result returned from Midjourney client');
    }
    
    // Process different response formats
    let imagePath = '';
    let resultImageUrl = '';
    let succeeded = false;
    
    // Check for upscaled_photo_url first (this is the grid image)
    if (mjResult.upscaled_photo_url) {
      console.log('🖼️ Processing upscaled_photo_url:', mjResult.upscaled_photo_url);
      resultImageUrl = mjResult.upscaled_photo_url;
      
      if (mjResult.upscaled_photo_url.includes('/recipe_images/')) {
        // This is a local file path already, extract just the filename
        imagePath = mjResult.upscaled_photo_url.split('/').pop();
        succeeded = true;
        console.log(`✅ Found local image path: ${imagePath}`);
      } else {
        // This is a URL that should have been downloaded by the client
        // Check if the file exists in our directory
        const possibleFilename = `grid_${Date.now()}.png`;
        const possiblePath = path.join(process.cwd(), 'recipe_images', possibleFilename);
        
        // Look for recently created files that match our pattern
        const recipeImagesDir = path.join(process.cwd(), 'recipe_images');
        if (fs.existsSync(recipeImagesDir)) {
          const files = fs.readdirSync(recipeImagesDir);
          const recentFiles = files.filter(file => {
            if (!file.startsWith('grid_') || !file.endsWith('.png')) return false;
            const filePath = path.join(recipeImagesDir, file);
            const stats = fs.statSync(filePath);
            const now = Date.now();
            const fileAge = now - stats.mtime.getTime();
            return fileAge < 60000; // Within last minute
          }).sort((a, b) => {
            const aPath = path.join(recipeImagesDir, a);
            const bPath = path.join(recipeImagesDir, b);
            const aStats = fs.statSync(aPath);
            const bStats = fs.statSync(bPath);
            return bStats.mtime.getTime() - aStats.mtime.getTime(); // Newest first
          });
          
          if (recentFiles.length > 0) {
            imagePath = recentFiles[0];
            succeeded = true;
            console.log(`✅ Found recently downloaded grid image: ${imagePath}`);
          } else {
            console.log(`⚠️ No recent grid images found, using fallback filename`);
            imagePath = possibleFilename;
            succeeded = false; // We'll mark as failed since we can't find the actual file
          }
        }
      }
    } 
    // Check for grid_info as fallback
    else if (mjResult.grid_info && mjResult.grid_info.grid_url) {
      console.log('🖼️ Processing grid_info.grid_url:', mjResult.grid_info.grid_url);
      resultImageUrl = mjResult.grid_info.grid_url;
      
      // Similar logic for grid_info
      const possibleFilename = `grid_${Date.now()}.png`;
      const recipeImagesDir = path.join(process.cwd(), 'recipe_images');
      if (fs.existsSync(recipeImagesDir)) {
        const files = fs.readdirSync(recipeImagesDir);
        const recentFiles = files.filter(file => {
          if (!file.startsWith('grid_') || !file.endsWith('.png')) return false;
          const filePath = path.join(recipeImagesDir, file);
          const stats = fs.statSync(filePath);
          const now = Date.now();
          const fileAge = now - stats.mtime.getTime();
          return fileAge < 60000; // Within last minute
        }).sort((a, b) => {
          const aPath = path.join(recipeImagesDir, a);
          const bPath = path.join(recipeImagesDir, b);
          const aStats = fs.statSync(aPath);
          const bStats = fs.statSync(bPath);
          return bStats.mtime.getTime() - aStats.mtime.getTime(); // Newest first
        });
        
        if (recentFiles.length > 0) {
          imagePath = recentFiles[0];
          succeeded = true;
          console.log(`✅ Found recently downloaded grid image (from grid_info): ${imagePath}`);
        } else {
          console.log(`⚠️ No recent grid images found (grid_info), using fallback filename`);
          imagePath = possibleFilename;
          succeeded = false;
        }
      }
    }
    
    // Update the database record with comprehensive verification
    const finalStatus = succeeded ? 'completed' : 'failed';
    const errorMessage = succeeded ? null : 'Image file not found after generation';

    console.log(`🔄 Attempting to update database record ${imageId} with status: ${finalStatus}`);
    console.log(`📁 Image path: ${imagePath}`);
    console.log(`🌐 Image URL: ${resultImageUrl}`);
    console.log(`🆔 Record ID type: ${typeof imageId}, value: ${imageId}`);

    try {
      // First, verify the record exists before updating
      const existingRecord = await getOne(
        "SELECT id, recipe_id, status FROM recipe_images WHERE id = ?",
        [imageId]
      );
      
      if (!existingRecord) {
        console.error(`❌ CRITICAL ERROR: Record with ID ${imageId} not found before update!`);
        
        // Try to find records for this recipe to see what went wrong
        const allRecordsForRecipe = await getAll(
          "SELECT id, status, image_path, created_at FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC",
          [recipeId]
        );
        
        console.error(`📋 All records for recipe ${recipeId}:`, allRecordsForRecipe);
        
        if (allRecordsForRecipe.length > 0) {
          // Use the most recent record (likely the one we just created)
          const mostRecentRecord = allRecordsForRecipe[0];
          console.log(`🔄 Attempting to use most recent record instead: ${mostRecentRecord.id}`);
          imageId = mostRecentRecord.id; // Update imageId to the correct UUID
          
          // Verify this record exists
          const reVerifyRecord = await getOne(
            "SELECT id, recipe_id, status FROM recipe_images WHERE id = ?",
            [imageId]
          );
          
          if (!reVerifyRecord) {
            throw new Error(`Even the most recent record ${imageId} not found`);
          }
          
          console.log(`✅ Found correct record:`, {
            id: reVerifyRecord.id,
            recipe_id: reVerifyRecord.recipe_id,
            current_status: reVerifyRecord.status
          });
        } else {
          throw new Error(`No records found for recipe ${recipeId}`);
        }
      } else {
        console.log(`✅ Found existing record:`, {
          id: existingRecord.id,
          recipe_id: existingRecord.recipe_id,
          current_status: existingRecord.status
        });
      }
      
      // Perform the update
      console.log(`🔄 Executing UPDATE query for record ${imageId}...`);
      const updateResult = await runQuery(
        "UPDATE recipe_images SET image_path = ?, discord_message_id = ?, status = ?, error = ? WHERE id = ?",
        [imagePath, mjResult.imagine_message_id || null, finalStatus, errorMessage, imageId]
      );
      
      console.log(`📊 Raw update result:`, updateResult);
      
      // Verify the update actually worked
      console.log(`🔍 Verifying update was successful...`);
      const verifiedRecord = await getOne(
        "SELECT id, recipe_id, status, image_path, error, discord_message_id FROM recipe_images WHERE id = ?",
        [imageId]
      );
      
      if (!verifiedRecord) {
        console.error(`❌ VERIFICATION FAILED: Record ${imageId} not found after update!`);
        throw new Error(`Record ${imageId} not found after update`);
      }
      
      console.log(`📋 Post-update verification:`, {
        id: verifiedRecord.id,
        recipe_id: verifiedRecord.recipe_id,
        status: verifiedRecord.status,
        image_path: verifiedRecord.image_path,
        error: verifiedRecord.error,
        discord_message_id: verifiedRecord.discord_message_id
      });
      
      // Check if the status actually changed
      if (verifiedRecord.status !== finalStatus) {
        console.error(`❌ STATUS UPDATE FAILED!`);
        console.error(`   Expected: ${finalStatus}`);
        console.error(`   Actual: ${verifiedRecord.status}`);
        throw new Error(`Status update failed - expected "${finalStatus}" but got "${verifiedRecord.status}"`);
      }
      
      // Check if image_path was set correctly (if we expected it to be set)
      if (succeeded && !verifiedRecord.image_path) {
        console.error(`❌ IMAGE PATH UPDATE FAILED!`);
        console.error(`   Expected: ${imagePath}`);
        console.error(`   Actual: ${verifiedRecord.image_path}`);
        throw new Error(`Image path update failed`);
      }
      
      console.log(`✅ Database update and verification successful for recipe ${recipeId}`);
      console.log(`🎉 Final status: ${verifiedRecord.status}`);
      
      // Additional logging for debugging
      console.log(`📈 Summary:`);
      console.log(`   - Recipe ID: ${recipeId}`);
      console.log(`   - Image Record ID: ${imageId}`);
      console.log(`   - Final Status: ${verifiedRecord.status}`);
      console.log(`   - Image Path: ${verifiedRecord.image_path || 'None'}`);
      console.log(`   - Discord Message ID: ${verifiedRecord.discord_message_id || 'None'}`);
      
    } catch (dbError) {
      console.error(`❌ DATABASE OPERATION FAILED:`, dbError);
      
      // Try to get current state for debugging
      try {
        const currentState = await getOne(
          "SELECT * FROM recipe_images WHERE id = ?",
          [imageId]
        );
        console.error(`📊 Current database state for record ${imageId}:`, currentState);
      } catch (stateError) {
        console.error(`❌ Could not retrieve current state: ${stateError.message}`);
      }
      
      // Try to get all records for this recipe to see if there are duplicates or ID mismatches
      try {
        const allRecords = await getAll(
          "SELECT id, status, image_path, created_at FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC",
          [recipeId]
        );
        console.error(`📋 All records for recipe ${recipeId}:`, allRecords);
        
        // If we have records but couldn't find the specific one, try updating the most recent
        if (allRecords.length > 0 && !allRecords.find(r => r.id === imageId)) {
          console.log(`🔄 Attempting emergency update on most recent record...`);
          const mostRecent = allRecords[0];
          
          const emergencyUpdate = await runQuery(
            "UPDATE recipe_images SET image_path = ?, status = ?, error = ? WHERE id = ?",
            [imagePath, finalStatus, errorMessage, mostRecent.id]
          );
          
          console.log(`🆘 Emergency update result:`, emergencyUpdate);
          
          // Update imageId for return value
          imageId = mostRecent.id;
        }
        
      } catch (allError) {
        console.error(`❌ Could not retrieve all records: ${allError.message}`);
      }
      
      // Re-throw the original error
      throw new Error(`Database update failed: ${dbError.message}`);
    }
    
    if (succeeded) {
      return {
        id: imageId,
        imagePath: imagePath,
        imageUrl: resultImageUrl,
        success: true,
        note: mjResult.note || 'Grid image processed successfully',
        filterResult: filterResult
      };
    } else {
      return {
        id: imageId,
        error: errorMessage || 'Image generation completed but file not found',
        success: false,
        filterResult: filterResult
      };
    }
    
  } catch (error) {
    console.error(`❌ Error generating image for recipe ${recipeId}:`, error.message);
    console.error('Full error:', error);
    
    // If we created a database record, update it with error status
    if (imageId) {
      try {
        await runQuery(
          "UPDATE recipe_images SET status = ?, error = ? WHERE id = ?",
          ['failed', error.message, imageId]
        );
        console.log(`Updated database record ${imageId} with failed status`);
      } catch (updateError) {
        console.error('Error updating failed status:', updateError.message);
      }
    }
    
    return {
      id: imageId,
      error: error.message,
      success: false
    };
  }
}

/**
 * UPDATED: Process a recipe and generate an image (now tries to get Discord settings globally)
 * @param {integer} recipeId - Recipe ID
 * @returns {Object} Result with status and image information
 */
async function generateImageForRecipe(recipeId) {
  try {
    console.log(`🎨 Starting image generation for recipe ID: ${recipeId}`);
    
    // Try to get Discord settings from global helper
    let discordSettings = null;
    if (global.getCurrentDiscordSettings) {
      discordSettings = global.getCurrentDiscordSettings();
      console.log('Got Discord settings from global helper:', {
        hasChannelId: !!(discordSettings?.discordChannelId),
        hasToken: !!(discordSettings?.discordUserToken),
        enabled: discordSettings?.enableDiscord
      });
    } else {
      console.log('⚠️ Global Discord settings helper not available');
    }
    
    // Use the new function with Discord settings
    return await generateImageForRecipeWithSettings(recipeId, discordSettings);
    
  } catch (error) {
    console.error(`Error in generateImageForRecipe: ${error.message}`);
    return {
      error: error.message,
      success: false
    };
  }
}

/**
 * Test prompt filtering function (for debugging)
 * @param {string} testPrompt - Prompt to test
 * @returns {Object} Filter test results
 */
function testPromptFilter(testPrompt) {
  console.log('\n🧪 [TEST] Testing prompt filter...');
  const result = filterPromptForMidjourney(testPrompt, { logChanges: true });
  console.log('🧪 [TEST] Filter test completed\n');
  return result;
}

/**
 * Get all recipe images from the database
 * @returns {Array} List of recipe images
 */
async function getAllRecipeImages() {
  // Use recipe_idea instead of title based on your schema
  return await getAll(`
    SELECT ri.*, r.recipe_idea as recipe_title 
    FROM recipe_images ri
    LEFT JOIN recipes r ON ri.recipe_id = r.id
    ORDER BY ri.created_at DESC
  `);
}

/**
 * Get images for a specific recipe
 * @param {integer} recipeId - Recipe ID
 * @returns {Array} List of images for the recipe
 */
async function getImagesForRecipe(recipeId) {
  return await getAll(
    "SELECT * FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC", 
    [recipeId]
  );
}

/**
 * Export recipe images to CSV
 * @returns {string} CSV content
 */
async function exportImagesToCSV() {
  // Use recipe_idea instead of title based on your schema
  const rows = await getAll(`
    SELECT ri.id, r.recipe_idea as recipe_title, ri.prompt, ri.image_path, ri.status, ri.created_at
    FROM recipe_images ri
    LEFT JOIN recipes r ON ri.recipe_id = r.id
    ORDER BY ri.created_at DESC
  `);
  
  // Create CSV content
  const csvHeader = "ID,Recipe Title,Prompt,Image Path,Status,Created At\n";
  const csvRows = rows.map(row => {
    return `${row.id},"${(row.recipe_title || '').replace(/"/g, '""')}","${row.prompt.replace(/"/g, '""')}",${row.image_path},${row.status},${row.created_at}`;
  }).join("\n");
  
  return csvHeader + csvRows;
}

/**
 * Delete a recipe image
 * @param {integer} imageId - Image ID
 * @returns {boolean} Success status
 */
async function deleteRecipeImage(imageId) {
  try {
    // Get the image information first
    const image = await getOne("SELECT * FROM recipe_images WHERE id = ?", [imageId]);
    
    if (!image) {
      throw new Error('Image not found');
    }
    
    // Delete the image file if it exists
    if (image.image_path) {
      const imagePath = path.join(process.cwd(), 'recipe_images', image.image_path);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }
    
    // Delete the database record
    await runQuery("DELETE FROM recipe_images WHERE id = ?", [imageId]);
    
    return true;
  } catch (error) {
    console.error(`Error deleting image ${imageId}:`, error.message);
    throw error;
  }
}

/**
 * Generate image for a recipe with a custom prompt
 * @param {string} recipeId - Recipe ID
 * @param {string} customPrompt - Custom Midjourney prompt
 * @returns {Promise<object>} - Result object
 */
async function generateImageForRecipeWithPrompt(recipeId, customPrompt) {
  try {
    console.log(`Generating image for recipe ${recipeId} with custom prompt`);
    
    // Try to get Discord settings
    let discordSettings = null;
    if (global.getCurrentDiscordSettings) {
      discordSettings = global.getCurrentDiscordSettings();
    }
    
    // Reset client instance to ensure fresh settings
    MidjourneyClient.resetInstance();
    
    // Get MJ client with settings
    const client = MidjourneyClient.getInstance(discordSettings);
    
    // Make sure it's initialized
    if (!client.userId || !client.guildId) {
      console.log('Client not initialized, initializing now...');
      await client.initialize();
    }
    
    // Check if there's already an image being generated for this recipe
    const pendingImage = await getOne(
      "SELECT id FROM recipe_images WHERE recipe_id = ? AND status = 'pending'",
      [recipeId]
    );
    
    if (pendingImage) {
      console.log(`Recipe ${recipeId} already has a pending image generation`);
      return {
        success: false,
        in_progress: true,
        message: 'Image generation already in progress for this recipe'
      };
    }
    
    // Create the image
    console.log(`Creating image with prompt: ${customPrompt.substring(0, 100)}...`);
    
    try {
      // Create the image with MJ
      const result = await client.createImage(customPrompt, '--v 5 --q 2', null);
      
      if (!result || !result.upscaled_photo_url) {
        throw new Error('Failed to generate image URL');
      }
      
      // Download the image
      const imagePath = await downloadAndSaveImage(result.upscaled_photo_url, recipeId);
      
      // Update the recipe_images record
      await runQuery(
        "UPDATE recipe_images SET image_path = ?, status = ?, error = NULL WHERE recipe_id = ? AND status = 'pending'",
        [imagePath, "completed", recipeId]
      );
      
      return {
        success: true,
        imageUrl: result.upscaled_photo_url,
        imagePath: imagePath
      };
    } catch (error) {
      console.error(`Error generating image with Midjourney: ${error.message}`);
      
      // Update the recipe_images record with error
      await runQuery(
        "UPDATE recipe_images SET status = ?, error = ? WHERE recipe_id = ? AND status = 'pending'",
        ["failed", error.message, recipeId]
      );
      
      throw error;
    }
  } catch (error) {
    console.error(`Error in generateImageForRecipeWithPrompt: ${error.message}`);
    throw error;
  }
}

// Helper function to download and save image
async function downloadAndSaveImage(imageUrl, recipeId) {
  try {
    const axios = require('axios');
    const fs = require('fs');
    const path = require('path');
    
    // Create recipe_images directory if it doesn't exist
    const outputDir = path.join(process.cwd(), 'recipe_images');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Generate a unique filename
    const timestamp = Date.now();
    const filename = `recipe_${recipeId}_${timestamp}.webp`;
    const outputPath = path.join(outputDir, filename);
    
    // Download the image
    const response = await axios({
      method: 'GET',
      url: imageUrl,
      responseType: 'stream'
    });
    
    // Save the image
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filename));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`Error downloading image: ${error.message}`);
    throw error;
  }
}

// Export functions
module.exports = {
  generateImageForRecipe,
  generateImageForRecipeWithSettings,
  generateImageForRecipeWithPrompt,
  getAllRecipeImages,
  getImagesForRecipe,
  exportImagesToCSV,
  deleteRecipeImage,
  testPromptFilter,
  filterPromptForMidjourney,
  addImageUrlToPrompt // Export the helper function for testing
};