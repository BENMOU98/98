// wordpress.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { cleanRecipeText } = require('./recipe-formatter');

/**
 * Clean and format a recipe for WordPress
 * @param {Object} recipeData - Raw recipe data
 * @returns {Object} - Cleaned recipe data for WordPress
 */
function cleanRecipeForWordPress(recipeData) {
  try {
    if (!recipeData) {
      return null;
    }
    
    // Make a deep copy to avoid modifying the original
    const cleanedRecipe = JSON.parse(JSON.stringify(recipeData));
    
    // Clean the title
    if (cleanedRecipe.title) {
      cleanedRecipe.title = cleanedRecipe.title
        .replace(/\*\*/g, '') // Remove markdown bold
        .trim();
    }
    
    // Clean the ingredients
    if (cleanedRecipe.ingredients && Array.isArray(cleanedRecipe.ingredients)) {
      cleanedRecipe.ingredients = cleanedRecipe.ingredients.map(ingredient => {
        // Skip if not a string
        if (typeof ingredient !== 'string') return ingredient;
        
        let clean = ingredient
          .replace(/^[-•*]\s*/, '') // Remove bullet points or asterisks
          .replace(/\*\*(.*?)\*\*/g, '$1') // Remove markdown bold but keep the content 
          .replace(/^###.*?###/g, '') // Remove section headers
          .replace(/🧂|🧑‍🍳/g, '') // Remove emojis
          .trim();
        
        return clean;
      }).filter(Boolean); // Remove null/empty items
    }
    
    // Clean the instructions
    if (cleanedRecipe.instructions && Array.isArray(cleanedRecipe.instructions)) {
      cleanedRecipe.instructions = cleanedRecipe.instructions.map(instruction => {
        // Skip if not a string
        if (typeof instruction !== 'string') return instruction;
        
        let clean = instruction
          .replace(/^(\d+)[\.\)]\s*["']?/, '') // Remove the numbering
          .replace(/\*\*(.*?)\*\*/g, '$1') // Remove markdown bold but keep the content
          .replace(/^["'](.*)["']$/, '$1') // Remove quotes around the entire instruction
          .replace(/^[\"\']?(.*?)[\"\']?$/, '$1') // Another way to remove quotes
          .replace(/^###.*?###/g, '') // Remove section headers
          .replace(/🧂|🧑‍🍳/g, '') // Remove emojis
          .trim();
        
        return clean;
      }).filter(Boolean); // Remove null/empty items
    }
    
    return cleanedRecipe;
  } catch (error) {
    console.error('Error cleaning recipe for WordPress:', error);
    return recipeData; // Return original if cleaning fails
  }
}

/**
 * Format content for WordPress Gutenberg blocks
 * @param {string} content - HTML content
 * @returns {string} Formatted content
 */
function formatContentForWordPress(content) {
  try {
    if (!content || typeof content !== 'string') {
      console.warn('Content is not a string, converting to string');
      content = String(content || '');
    }
    
    // Check if the content already has HTML tags
    const hasHtmlTags = /<\/?[a-z][\s\S]*>/i.test(content);
    
    if (hasHtmlTags) {
      // Convert HTML content to WordPress Gutenberg blocks
      return content
        .replace(/<h2>(.*?)<\/h2>/gi, '<!-- wp:heading --><h2>$1</h2><!-- /wp:heading -->')
        .replace(/<h3>(.*?)<\/h3>/gi, '<!-- wp:heading {"level":3} --><h3>$1</h3><!-- /wp:heading -->')
        .replace(/<p>(.*?)<\/p>/gi, '<!-- wp:paragraph --><p>$1</p><!-- /wp:paragraph -->')
        .replace(/<ul>([\s\S]*?)<\/ul>/gi, '<!-- wp:list --><ul>$1</ul><!-- /wp:list -->')
        .replace(/<ol>([\s\S]*?)<\/ol>/gi, '<!-- wp:list {"ordered":true} --><ol>$1</ol><!-- /wp:list -->');
    } else {
      // Format plain text as WordPress blocks
      return content
        .split('\n\n')
        .map(para => para.trim())
        .filter(para => para.length > 0)
        .map(para => {
          if (para.startsWith('# ')) {
            return `<!-- wp:heading --><h2>${para.substring(2)}</h2><!-- /wp:heading -->`;
          } else if (para.startsWith('## ')) {
            return `<!-- wp:heading --><h2>${para.substring(3)}</h2><!-- /wp:heading -->`;
          } else if (para.startsWith('### ')) {
            return `<!-- wp:heading {"level":3} --><h3>${para.substring(4)}</h3><!-- /wp:heading -->`;
          } else {
            return `<!-- wp:paragraph --><p>${para}</p><!-- /wp:paragraph -->`;
          }
        })
        .join('\n\n');
    }
  } catch (error) {
    console.error('Error formatting content:', error);
    return String(content || '');
  }
}

/**
 * Check if post should have a recipe based on keywords and config
 * @param {string} postTitle - Post title 
 * @param {Object} wprmConfig - WP Recipe Maker configuration
 * @returns {boolean} True if recipe should be added
 */
function shouldAddRecipe(postTitle, wprmConfig) {
  // If WPRM integration is not enabled, return false
  if (!wprmConfig || !wprmConfig.enabled) {
    return false;
  }
  
  // If addToAllPosts is enabled, always return true
  if (wprmConfig.addToAllPosts) {
    return true;
  }
  
  // Check keywords
  if (wprmConfig.keywords) {
    const keywordList = wprmConfig.keywords.split(',').map(k => k.trim().toLowerCase());
    const titleLower = postTitle.toLowerCase();
    
    return keywordList.some(keyword => titleLower.includes(keyword));
  }
  
  return false;
}

/**
 * Apply SEO metadata to a WordPress post via Rank Math
 * @param {Object} wpClient - WordPress client instance
 * @param {Object} seoMetadata - SEO metadata (title, description, permalink, keyword)
 * @param {number|string} postId - WordPress post ID
 * @returns {Object} WordPress API response
 */
async function applySeoMetadataToPost(wpClient, seoMetadata, postId) {
  try {
    if (!wpClient || !seoMetadata || !postId) {
      throw new Error('Missing required parameters for applying SEO metadata');
    }
    
    console.log(`Applying SEO metadata to post ID: ${postId}`);
    
    // Check if this is a temporary ID
    if (typeof postId === 'string' && postId.startsWith('temp_')) {
      console.log('Post ID is temporary. Storing SEO metadata for later use.');
      return {
        success: true,
        message: 'SEO metadata stored for later use',
        isTemporary: true
      };
    }
    
    // Ensure token is available
    if (!wpClient.token) {
      await wpClient.authenticate();
    }
    
    // Get auth headers
    const headers = wpClient.authType === 'jwt'
      ? { 'Authorization': `Bearer ${wpClient.token}` }
      : { 'Authorization': `Basic ${wpClient.token}` };
    
    // Create a copy of the metadata to avoid modifying the original
    const metadataToSend = {...seoMetadata};
    
    // Ensure we have clean data
    metadataToSend.title = metadataToSend.title || '';
    metadataToSend.description = metadataToSend.description || '';
    metadataToSend.keyword = metadataToSend.keyword || '';
    
    // These are the meta field names that Rank Math uses
    const metaData = {
      'rank_math_title': metadataToSend.title,
      'rank_math_description': metadataToSend.description,
      'rank_math_focus_keyword': metadataToSend.keyword
    };
    
    // Log the metadata being sent
    console.log('Setting Rank Math metadata:');
    console.log(JSON.stringify(metaData, null, 2));
    
    // Update permalink if provided
    if (seoMetadata.permalink) {
      console.log(`Updating post permalink to: ${seoMetadata.permalink}`);
      
      // Clean up the permalink
      const cleanSlug = seoMetadata.permalink
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      
      try {
        await axios.post(
          `${wpClient.baseUrl}/posts/${postId}`,
          { slug: cleanSlug },
          {
            headers: {
              ...headers,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log(`✓ Post slug updated to: ${cleanSlug}`);
      } catch (slugError) {
        console.error('Error updating slug:', slugError.message);
        // Continue with other updates even if slug update fails
      }
    }
    
    // Update the SEO metadata
    try {
      const metaResponse = await axios.post(
        `${wpClient.baseUrl}/posts/${postId}`,
        { meta: metaData },
        {
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log('✓ SEO metadata updated successfully');
      
      return {
        success: true,
        data: metaResponse.data
      };
    } catch (metaError) {
      console.error('Error updating post meta:', metaError.message);
      throw metaError;
    }
  } catch (error) {
    console.error('Error applying SEO metadata:', error);
    throw error;
  }
}

class WordPressClientClass {
  constructor(config) {
    this.baseUrl = config.siteUrl.replace(/\/$/, '') + '/wp-json/wp/v2';
    this.username = config.username;
    this.password = config.password;
    this.token = null;
    this.authType = 'basic'; // Default to basic auth
  }

  /**
   * Test the WordPress API connection
   * @returns {Object} Connection test result
   */
  async testConnection() {
    try {
      console.log(`Testing WordPress API connection to ${this.baseUrl}...`);
      
      // Test authentication using WordPress users/me endpoint
      const authString = `${this.username}:${this.password}`;
      const encodedAuth = Buffer.from(authString).toString('base64');
      
      const response = await axios.get(
        `${this.baseUrl}/users/me`,
        {
          headers: {
            'Authorization': `Basic ${encodedAuth}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✓ Authentication successful as: ${response.data.name}`);
      return {
        success: true,
        name: response.data.name,
        roles: response.data.roles,
        description: 'Authentication successful'
      };
    } catch (error) {
      console.error('✗ WordPress connection test failed:', error.message);
      throw new Error('WordPress connection test failed: ' + (error.response?.data?.message || error.message));
    }
  }

  /**
   * Authenticate with WordPress
   * @returns {boolean} Authentication success
   */
  async authenticate() {
    try {
      // First try Basic Auth (more widely supported without plugins)
      this.token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      this.authType = 'basic';
      
      // Test if Basic Auth works with a simple request
      try {
        const testResponse = await axios.get(
          `${this.baseUrl}/users/me`,
          {
            headers: {
              'Authorization': `Basic ${this.token}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        console.log('Basic Auth successful:', testResponse.data.name);
        return true;
      } catch (basicAuthError) {
        console.log('Basic Auth failed, trying JWT:', basicAuthError.message);
        
        // Try JWT if Basic Auth fails
        try {
          const authUrl = this.baseUrl.replace('/wp/v2', '') + '/jwt-auth/v1/token';
          const response = await axios.post(authUrl, {
            username: this.username,
            password: this.password
          });
          
          if (response.data && response.data.token) {
            this.token = response.data.token;
            this.authType = 'jwt';
            console.log('JWT Auth successful');
            return true;
          }
        } catch (jwtError) {
          console.error('JWT Auth also failed:', jwtError.message);
          throw new Error('Authentication failed. Please check your WordPress credentials and ensure your user has proper permissions.');
        }
      }
      
      return false;
    } catch (error) {
      console.error('WordPress authentication error:', error.response?.data || error.message);
      throw new Error('Failed to authenticate with WordPress: ' + (error.response?.data?.message || error.message));
    }
  }

  /**
   * Get MIME type from filename
   * @param {string} filename - Filename
   * @returns {string} MIME type
   */
  getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    return mimeTypes[ext] || 'image/jpeg';
  }

  /**
   * Upload an image to WordPress Media Library
   * @param {string} imagePath - Local path to the image file
   * @param {string} filename - Filename for the uploaded image
   * @param {string} altText - Alt text for the image
   * @returns {Object} WordPress media object
   */
  async uploadImageToMedia(imagePath, filename, altText = '') {
    try {
      if (!this.token) {
        await this.authenticate();
      }

      // Check if file exists
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }

      // Read the image file
      const imageBuffer = fs.readFileSync(imagePath);
      const mimeType = this.getMimeType(filename);

      // Determine headers based on auth type
      const headers = this.authType === 'jwt'
        ? { 'Authorization': `Bearer ${this.token}` }
        : { 'Authorization': `Basic ${this.token}` };

      // Add content headers
      headers['Content-Type'] = mimeType;
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;

      console.log(`Uploading image to WordPress: ${filename}`);

      // Upload to WordPress media library
      const response = await axios.post(
        `${this.baseUrl}/media`,
        imageBuffer,
        { headers }
      );

      console.log(`✅ Image uploaded successfully - Media ID: ${response.data.id}`);

      // Update alt text if provided
      if (altText) {
        await this.updateMediaAltText(response.data.id, altText);
      }

      return response.data;
    } catch (error) {
      console.error('Error uploading image to WordPress:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Update alt text for a media item
   * @param {number} mediaId - WordPress media ID
   * @param {string} altText - Alt text to set
   */
  async updateMediaAltText(mediaId, altText) {
    try {
      const headers = this.authType === 'jwt'
        ? { 'Authorization': `Bearer ${this.token}` }
        : { 'Authorization': `Basic ${this.token}` };

      await axios.post(
        `${this.baseUrl}/media/${mediaId}`,
        { alt_text: altText },
        {
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Alt text updated for media ID: ${mediaId}`);
    } catch (error) {
      console.warn('Warning: Could not update alt text:', error.message);
      // Don't throw error as this is not critical
    }
  }

  /**
   * Set featured image for a post
   * @param {number} postId - WordPress post ID
   * @param {number} mediaId - WordPress media ID
   */
  async setFeaturedImage(postId, mediaId) {
    try {
      if (!this.token) {
        await this.authenticate();
      }

      const headers = this.authType === 'jwt'
        ? { 'Authorization': `Bearer ${this.token}` }
        : { 'Authorization': `Basic ${this.token}` };

      console.log(`Setting featured image for post ${postId} - Media ID: ${mediaId}`);

      const response = await axios.post(
        `${this.baseUrl}/posts/${postId}`,
        { featured_media: mediaId },
        {
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`✅ Featured image set successfully`);
      return response.data;
    } catch (error) {
      console.error('Error setting featured image:', error.message);
      throw error;
    }
  }

  /**
   * Create post with featured image
   * @param {Object} postData - Post data
   * @param {string} imagePath - Path to featured image (optional)
   * @param {string} imageAltText - Alt text for image (optional)
   * @returns {Object} Post creation result
   */
  async createPostWithFeaturedImage(postData, imagePath = null, imageAltText = '') {
    try {
      // Create the post first
      const post = await this.createPost(postData);
      
      // If image is provided, upload and set as featured image
      if (imagePath && fs.existsSync(imagePath)) {
        try {
          const filename = path.basename(imagePath);
          const altText = imageAltText || postData.title || 'Recipe image';
          
          // Upload image to WordPress media library
          const mediaObject = await this.uploadImageToMedia(imagePath, filename, altText);
          
          // Set as featured image
          await this.setFeaturedImage(post.id, mediaObject.id);
          
          // Add media info to response
          post.featured_media = mediaObject.id;
          post.featured_image_url = mediaObject.source_url;
          
          console.log(`✅ Post created with featured image: ${post.link}`);
        } catch (imageError) {
          console.warn('Warning: Post created but featured image failed:', imageError.message);
          // Continue without failing the entire operation
        }
      }
      
      return post;
    } catch (error) {
      console.error('Error creating post with featured image:', error);
      throw error;
    }
  }

  /**
   * Create a WordPress post
   * @param {Object} postData - Post data
   * @returns {Object} Created post data
   */
  async createPost(postData) {
    try {
      if (!this.token) {
        await this.authenticate();
      }

      // Determine headers based on auth type
      const headers = this.authType === 'jwt'
        ? { 'Authorization': `Bearer ${this.token}` }
        : { 'Authorization': `Basic ${this.token}` };
      
      console.log('Creating post with auth type:', this.authType);
      
      // Format content for WordPress if necessary
      if (postData.content && postData.formatContent !== false) {
        postData.content = formatContentForWordPress(postData.content);
      }
      
      // Create post data object
      const postDataObject = {
        title: postData.title,
        content: postData.content,
        status: postData.status || 'draft',
        slug: postData.slug || ''
      };
      
      // Only add categories if they exist and are valid
      if (postData.categories && Array.isArray(postData.categories) && postData.categories.length > 0) {
        postDataObject.categories = postData.categories;
      }
      
      // Log the request details (without sensitive info)
      console.log('WordPress post request:', {
        url: `${this.baseUrl}/posts`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': headers.Authorization ? 'Set' : 'Not set' },
        data: { ...postDataObject, content: postDataObject.content ? `${postDataObject.content.substring(0, 50)}...` : 'No content' }
      });
      
      // Make the request with detailed error logging
      try {
        const response = await axios.post(`${this.baseUrl}/posts`, postDataObject, {
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          }
        });
        
        return response.data;
      } catch (requestError) {
        // Enhanced error logging
        console.error('WordPress API error details:', {
          message: requestError.message,
          status: requestError.response?.status,
          statusText: requestError.response?.statusText,
          data: requestError.response?.data,
          headers: requestError.response?.headers
        });
        
        if (requestError.response?.data?.message) {
          throw new Error(`WordPress API error: ${requestError.response.data.message}`);
        } else {
          throw requestError;
        }
      }
    } catch (error) {
      console.error('WordPress create post error:', error.message);
      throw new Error('Failed to create WordPress post: ' + (error.response?.data?.message || error.message));
    }
  }

  /**
   * Create a recipe in WordPress
   * @param {Object} recipeData - Recipe data
   * @returns {Object} Create result
   */
  async createRecipe(recipeData) {
    try {
      // Clean the recipe using the function we defined
      const cleanedRecipe = cleanRecipeForWordPress(recipeData);
      
      // Determine headers based on auth type
      const headers = this.authType === 'jwt'
        ? { 'Authorization': `Bearer ${this.token}` }
        : { 'Authorization': `Basic ${this.token}` };
      
      // Use the cleaned data to create the recipe in WordPress
      const response = await axios.post(
        `${this.baseUrl.replace('/wp/v2', '')}/wprm/v1/recipe`, 
        {
          title: cleanedRecipe.title,
          summary: cleanedRecipe.summary,
          ingredients: cleanedRecipe.ingredients,
          instructions: cleanedRecipe.instructions,
          // ... other fields from your original function
        },
        {
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error) {
      console.error('Error creating recipe in WordPress:', error);
      throw new Error('Failed to create recipe in WordPress: ' + (error.response?.data?.message || error.message));
    }
  }

  /**
   * Apply SEO metadata to a WordPress post using Rank Math
   * @param {number} postId - The WordPress post ID
   * @param {Object} seoMetadata - SEO metadata (title, description, permalink, keyword)
   * @returns {Object} - Result of the operation
   */
  async applySeoMetadata(postId, seoMetadata) {
    try {
      if (!this.token) {
        await this.authenticate();
      }
      
      // Validate required parameters
      if (!postId || !seoMetadata) {
        throw new Error('Post ID and SEO metadata are required');
      }
      
      console.log(`Applying SEO metadata to post ID: ${postId}`);
      
      // Log the metadata being applied
      console.log('SEO Metadata:', {
        title: seoMetadata.title || '[Not provided]',
        description: seoMetadata.description || '[Not provided]',
        focus_keyword: seoMetadata.keyword || '[Not provided]',
        permalink: seoMetadata.permalink || '[Not provided]'
      });
      
      // Create the meta data object for Rank Math
      const metaData = {
        'rank_math_title': seoMetadata.title || '',
        'rank_math_description': seoMetadata.description || '',
        'rank_math_focus_keyword': seoMetadata.keyword || ''
      };
      
      // Determine headers based on auth type
      const headers = this.authType === 'jwt'
        ? { 'Authorization': `Bearer ${this.token}` }
        : { 'Authorization': `Basic ${this.token}` };
      
      // Update the SEO metadata
      const response = await axios.post(
        `${this.baseUrl}/posts/${postId}`,
        { meta: metaData },
        {
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          }
        }
      );
      
      // Update permalink if provided and different from current
      if (seoMetadata.permalink) {
        const cleanSlug = seoMetadata.permalink
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');
        
        await axios.post(
          `${this.baseUrl}/posts/${postId}`,
          { slug: cleanSlug },
          {
            headers: {
              ...headers,
              'Content-Type': 'application/json'
            }
          }
        );
        
        console.log(`✓ Post slug updated to: ${cleanSlug}`);
      }
      
      console.log('✓ SEO metadata updated successfully');
      
      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('Error applying SEO metadata:', error);
      throw new Error(`Failed to apply SEO metadata: ${error.message}`);
    }
  }

  /**
   * Validate WordPress connection
   * @returns {Object} Validation result
   */
  async validateConnection() {
    try {
      if (!this.token) {
        await this.authenticate();
      }
      
      // Check if we're using JWT or basic auth
      const headers = this.authType === 'jwt'
        ? { 'Authorization': `Bearer ${this.token}` }
        : { 'Authorization': `Basic ${this.token}` };
      
      // Try to get site information to validate connection
      const infoUrl = this.baseUrl.replace('/wp/v2', '');
      const response = await axios.get(infoUrl, {
        headers
      });
      
      return {
        success: true,
        name: response.data?.name || 'WordPress Site',
        description: response.data?.description || '',
        url: response.data?.url || this.baseUrl
      };
    } catch (error) {
      console.error('WordPress connection validation error:', error.response?.data || error.message);
      throw new Error('Failed to validate WordPress connection: ' + (error.response?.data?.message || error.message));
    }
  }

  /**
   * Publish a recipe to WordPress
   * @param {Object} postData - Post data
   * @param {Object} recipeData - Recipe data (optional)
   * @param {Object} wprmConfig - WP Recipe Maker configuration (optional)
   * @returns {Object} Publish result
   */
  async publishWithRecipe(postData, recipeData, wprmConfig = null) {
    try {
      if (!this.token) {
        await this.authenticate();
      }

      // Create post first
      const postResult = await this.createPost(postData);
      const postId = postResult.id;
      
      // If we have recipe data and WPRM is enabled, add the recipe
      if (recipeData && (wprmConfig && wprmConfig.enabled)) {
        try {
          // Import recipe helper if it isn't already available
          const recipeHelper = require('./recipe-helper');
          
          // Check if we should add a recipe based on keywords
          const shouldAdd = wprmConfig.addToAllPosts || 
                            shouldAddRecipe(postData.title, wprmConfig);
          
          console.log(`Should add recipe? ${shouldAdd} (addToAllPosts: ${wprmConfig.addToAllPosts})`);
          
          if (shouldAdd) {
            // Clean recipe data using our function
            const cleanedRecipe = cleanRecipeForWordPress(recipeData);
            
            // Make sure original arrays are set
            if (!cleanedRecipe._originalIngredients && cleanedRecipe.ingredients) {
              cleanedRecipe._originalIngredients = [...cleanedRecipe.ingredients];
            }
            
            if (!cleanedRecipe._originalInstructions && cleanedRecipe.instructions) {
              cleanedRecipe._originalInstructions = [...cleanedRecipe.instructions];
            }
            
            // Use our createRecipe method or the recipe helper
            let recipeResult;
            if (typeof this.createRecipe === 'function') {
              recipeResult = await this.createRecipe(cleanedRecipe);
            } else {
              recipeResult = await recipeHelper.addRecipeToPost(
                { 
                  siteUrl: this.baseUrl.replace('/wp-json/wp/v2', ''),
                  username: this.username,
                  password: this.password
                },
                cleanedRecipe,
                postId
              );
            }
            
            return {
              success: true,
              post: postResult,
              recipe: recipeResult
            };
          }
        } catch (recipeError) {
          console.error('Error adding recipe to post:', recipeError);
          // Continue despite recipe error
          return {
            success: true,
            post: postResult,
            recipeError: recipeError.message
          };
        }
      }
      
      return {
        success: true,
        post: postResult
      };
    } catch (error) {
      console.error('WordPress publish with recipe error:', error);
      throw error;
    }
  }
}

// This will make WordPressClient directly importable without object destructuring 
// which matches how it's used in server.js
const WordPressClient = WordPressClientClass;

// Export WordPressClient as the default export
module.exports = WordPressClient;

// Also export the utility functions and class to maintain compatibility with both import styles
module.exports.WordPressClient = WordPressClientClass; 
module.exports.formatContentForWordPress = formatContentForWordPress;
module.exports.shouldAddRecipe = shouldAddRecipe;
module.exports.cleanRecipeForWordPress = cleanRecipeForWordPress;
module.exports.applySeoMetadataToPost = applySeoMetadataToPost;