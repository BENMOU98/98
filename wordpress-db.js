// wordpress-db.js
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Create a connection to the database
const db = new sqlite3.Database(path.join(__dirname, 'data', 'recipes.db'));

// Helper to run queries as promises
function runQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve({ lastID: this.lastID, changes: this.changes, id: params[0] });
            }
        });
    });
}

// Helper to get a single row
function getOne(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

// Helper to get multiple rows
function getAll(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

// Create the necessary tables if they don't exist
// Update the initTables function in wordpress-db.js to include website_id column
// Fix for the initTables function in wordpress-db.js

async function initTables() {
  try {
    // WordPress settings table with website_id column
    await runQuery(`
      CREATE TABLE IF NOT EXISTS wordpress_settings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'default',
        website_id TEXT,
        site_url TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        default_status TEXT DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, website_id)
      )
    `);

    // WordPress publications history
    await runQuery(`
      CREATE TABLE IF NOT EXISTS wordpress_publications (
        id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL,
        wp_post_id TEXT NOT NULL,
        wp_post_url TEXT NOT NULL,
        wp_status TEXT DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
      )
    `);

    // Check if website_id column exists in wordpress_publications
    const columnsQuery = await getAll(
      `PRAGMA table_info(wordpress_publications)`
    );
    
    // If website_id column doesn't exist, add it
    const hasWebsiteColumn = columnsQuery && Array.isArray(columnsQuery) && 
                            columnsQuery.some(col => col.name === 'website_id');
    
    if (!hasWebsiteColumn) {
      try {
        await runQuery(`
          ALTER TABLE wordpress_publications 
          ADD COLUMN website_id TEXT
        `);
        console.log('Added website_id column to wordpress_publications table');
      } catch (alterError) {
        console.error('Error adding website_id column:', alterError);
        // Fall back to recreating the table if ALTER TABLE fails
        try {
          // First backup the existing data
          const existingData = await getAll(`SELECT * FROM wordpress_publications`);
          
          // Drop and recreate the table with the new column
          await runQuery(`DROP TABLE IF EXISTS wordpress_publications_backup`);
          await runQuery(`ALTER TABLE wordpress_publications RENAME TO wordpress_publications_backup`);
          
          await runQuery(`
            CREATE TABLE wordpress_publications (
              id TEXT PRIMARY KEY,
              recipe_id TEXT NOT NULL,
              website_id TEXT,
              wp_post_id TEXT NOT NULL,
              wp_post_url TEXT NOT NULL,
              wp_status TEXT DEFAULT 'draft',
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
            )
          `);
          
          // Restore the data
          if (existingData && existingData.length > 0) {
            for (const row of existingData) {
              await runQuery(
                `INSERT INTO wordpress_publications 
                (id, recipe_id, wp_post_id, wp_post_url, wp_status, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  row.id,
                  row.recipe_id,
                  row.wp_post_id,
                  row.wp_post_url,
                  row.wp_status,
                  row.created_at
                ]
              );
            }
          }
          
          console.log('Recreated wordpress_publications table with website_id column');
        } catch (recreateError) {
          console.error('Error recreating wordpress_publications table:', recreateError);
        }
      }
    }

    console.log('WordPress tables initialized');
  } catch (error) {
    console.error('Error initializing WordPress tables:', error);
    throw error;
  }
}

// Initialize tables when the module is loaded
initTables();

// WordPress operations
const wordpressDb = {
    // Save or update WordPress settings
    async saveSettings(settings) {
    try {
        // Add website_id to settings if global.currentWebsiteId exists
        if (global.currentWebsiteId) {
            settings.website_id = global.currentWebsiteId;
        }
        
        const userId = settings.userId || 'default';
        const websiteId = settings.website_id || null;
        
        console.log(`Saving WordPress settings for user ${userId} and website ${websiteId || 'NULL'}`);
        
        // Check if we have a record for this specific user+website combination
        let query, params;
        
        if (websiteId) {
            query = `SELECT id FROM wordpress_settings WHERE user_id = ? AND website_id = ?`;
            params = [userId, websiteId];
        } else {
            query = `SELECT id FROM wordpress_settings WHERE user_id = ? AND (website_id IS NULL OR website_id = '')`;
            params = [userId];
        }
        
        const existingRecord = await getOne(query, params);
        
        if (existingRecord) {
            // Update the existing record for this user+website combination
            console.log(`Updating existing record with ID: ${existingRecord.id}`);
            await runQuery(
                `UPDATE wordpress_settings 
                SET site_url = ?, username = ?, password = ?, 
                default_status = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
                [
                    settings.siteUrl,
                    settings.username,
                    settings.password,
                    settings.defaultStatus || 'draft',
                    existingRecord.id
                ]
            );
            return existingRecord.id;
        } else {
            // Create a new record for this user+website combination
            console.log(`Creating new WordPress settings record for user ${userId} and website ${websiteId || 'NULL'}`);
            const id = uuidv4();
            await runQuery(
                `INSERT INTO wordpress_settings 
                (id, user_id, website_id, site_url, username, password, default_status)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    id,
                    userId,
                    websiteId,
                    settings.siteUrl,
                    settings.username,
                    settings.password,
                    settings.defaultStatus || 'draft'
                ]
            );
            return id;
        }
    } catch (error) {
        console.error('Error saving WordPress settings:', error);
        throw error;
    }
},
    
    // Get WordPress settings
    async getSettings(userId = 'default') {
    try {
        // Check for website_id filter
        const websiteId = global.currentWebsiteId;
        
        console.log(`Getting WordPress settings for user ${userId} and website ${websiteId || 'NULL'}`);
        
        let query, params;
        
        if (websiteId) {
            // Try to get settings for specific website
            query = `
                SELECT id, user_id, website_id, site_url, username, password, 
                default_status, created_at, updated_at
                FROM wordpress_settings
                WHERE user_id = ? AND website_id = ?
            `;
            params = [userId, websiteId];
        } else {
            // Try to get default/global settings (NULL website_id)
            query = `
                SELECT id, user_id, website_id, site_url, username, password, 
                default_status, created_at, updated_at
                FROM wordpress_settings
                WHERE user_id = ? AND (website_id IS NULL OR website_id = '')
            `;
            params = [userId];
        }
        
        const settings = await getOne(query, params);
        
        if (!settings && websiteId) {
            // If no settings found for this website, fall back to default settings
            console.log(`No settings found for website ${websiteId}, falling back to default settings`);
            
            const fallbackQuery = `
                SELECT id, user_id, website_id, site_url, username, password, 
                default_status, created_at, updated_at
                FROM wordpress_settings
                WHERE user_id = ? AND (website_id IS NULL OR website_id = '')
            `;
            
            return await getOne(fallbackQuery, [userId]);
        }
        
        return settings;
    } catch (error) {
        console.error('Error getting WordPress settings:', error);
        throw error;
    }
},
    
    // Save publication history
    // Update the savePublication function to include website_id
// Updated savePublication function
async savePublication(data) {
  try {
    const id = uuidv4();
    
    // Check if website_id column exists
    const columnsQuery = await getAll(`PRAGMA table_info(wordpress_publications)`);
    const hasWebsiteColumn = columnsQuery && Array.isArray(columnsQuery) && 
                            columnsQuery.some(col => col.name === 'website_id');
    
    if (hasWebsiteColumn) {
      await runQuery(
        `INSERT INTO wordpress_publications 
        (id, recipe_id, wp_post_id, wp_post_url, wp_status, website_id)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.recipeId,
          data.wpPostId.toString(),
          data.wpPostUrl,
          data.wpStatus || 'draft',
          data.websiteId || null
        ]
      );
    } else {
      // Fall back to the original query without website_id
      await runQuery(
        `INSERT INTO wordpress_publications 
        (id, recipe_id, wp_post_id, wp_post_url, wp_status)
        VALUES (?, ?, ?, ?, ?)`,
        [
          id,
          data.recipeId,
          data.wpPostId.toString(),
          data.wpPostUrl,
          data.wpStatus || 'draft'
        ]
      );
    }
    
    return id;
  } catch (error) {
    console.error('Error saving WordPress publication:', error);
    throw error;
  }
},
    
    // Get publication history for a recipe
    async getPublicationsByRecipeId(recipeId) {
        try {
            return await getAll(
                `SELECT id, recipe_id, wp_post_id, wp_post_url, wp_status, created_at
                FROM wordpress_publications
                WHERE recipe_id = ?
                ORDER BY created_at DESC`,
                [recipeId]
            );
        } catch (error) {
            console.error('Error getting WordPress publications:', error);
            throw error;
        }
    },
    
    // Get count of publications for a user or organization
    // Update the getPublicationCount function in wordpress-db.js
// Updated getPublicationCount function
async getPublicationCount(userId = null, organizationId = null, websiteId = null) {
  try {
    let query = `
      SELECT COUNT(*) as count 
      FROM wordpress_publications wp
      JOIN recipes r ON wp.recipe_id = r.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (userId && organizationId) {
      // Get count for a specific user within an organization
      query += ` AND r.owner_id = ? AND r.organization_id = ?`;
      params.push(userId, organizationId);
    } else if (userId) {
      // Get count for a specific user
      query += ` AND r.owner_id = ?`;
      params.push(userId);
    } else if (organizationId) {
      // Get count for an organization
      query += ` AND r.organization_id = ?`;
      params.push(organizationId);
    }
    
    // Add website filter if specified
    if (websiteId) {
      // Check if the website_id column exists
      const columnsQuery = await getAll(`PRAGMA table_info(wordpress_publications)`);
      const hasWebsiteColumn = columnsQuery && Array.isArray(columnsQuery) && 
                              columnsQuery.some(col => col.name === 'website_id');
      
      if (hasWebsiteColumn) {
        query += ` AND wp.website_id = ?`;
        params.push(websiteId);
      } else {
        console.warn('wordpress_publications table does not have website_id column, website filtering will not work');
      }
    }
    
    const result = await getOne(query, params);
    return result ? result.count : 0;
  } catch (error) {
    console.error('Error getting WordPress publication count:', error);
    return 0;
  }
}
};

// Export functions and the database object
module.exports = {
    ...wordpressDb,
    getOne,
    getAll,
    runQuery
};