// Updated server.js with database integration
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const axios = require('axios');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');
const { generatePinterestContent, generateBlogPost, generateFacebookContent } = require('./app');
const { recipeDb, facebookDb, pinterestDb, blogDb, keywordsDb } = require('./db');
const expressLayouts = require('express-ejs-layouts');
const WordPressClient = require('./wordpress');
const wordpressDb = require('./wordpress-db');
const apiKeyManager = require('./api-key-manager');
const recipeTemplateSettings = require('./recipe-template-settings');
const userDb = require('./models/user');
const organizationDb = require('./models/organization');
const { isAuthenticated, isAdmin, isEmployee, isResourceOwner, attachOrganizationToRequest, attachUserToLocals } = require('./middleware/auth');
const authRoutes = require('./auth-routes');
const registrationRoutes = require('./registration-routes');
const activityMiddleware = require('./middleware/activity-middleware');
const { runQuery, getOne, getAll } = require('./db');
const websiteDb = require('./models/website');
const fixAttachUserToLocals = require('./fix-template-variables');
const promptSettingsDb = require('./prompt-settings-db');
const db = require('./db');
const midjourneyRoutes = require('./midjourney/image-routes');
const imageGenerator = require('./midjourney/image-generator');
const auth = require('./middleware/auth');
const { Parser } = require('json2csv');


// Load environment variables
dotenv.config();

// Load environment variables
dotenv.config();

// Add this code for API key management
const { getApiKey, saveApiKey, isApiKeyMissing } = require('./api-key-manager');

// Replace your checkApiKeyMiddleware function with this
async function checkApiKeyMiddleware(req, res, next) {
  // Skip check for authentication-related routes and public routes
  const exemptRoutes = [
    '/login', 
    '/register',
    '/logout',
    '/settings', 
    '/api/test-connection',
    '/favicon.ico',
    '/public',
    '/api/keys'
  ];
  
  // Check if the current route is exempt
  for (const route of exemptRoutes) {
    if (req.path.startsWith(route)) {
      return next();
    }
  }
  
  // Check if OpenAI API key is missing
  const openaiKeyMissing = await isApiKeyMissing('openai');
  
  if (openaiKeyMissing) {
    // If it's an API request, return JSON error
    if (req.path.startsWith('/api/')) {
      return res.status(400).json({
        success: false,
        message: 'OpenAI API key is required. Please add your API key in the settings page.'
      });
    }
    
    // For regular page requests, redirect to settings with a warning
    req.session.errorMessage = 'OpenAI API key is required to use this application. Please add your API key below.';
    return res.redirect('/settings');
  }
  
  next();
}


// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Set up sessions with proper configuration
app.use(session({
  secret: 'recipe-content-generator-secret',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Set to true in production
    maxAge: 1000 * 60 * 60 * 24 // 24 hours
  }
}));

// Add these debugging lines after session middleware to check session state
app.use((req, res, next) => {
  // Debug session info without exposing sensitive data
  console.log('Session debug:', {
    hasSession: !!req.session,
    hasUser: !!(req.session && req.session.user),
    sessionID: req.sessionID,
    url: req.originalUrl
  });
  next();
});

// Setup view engine and layouts
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/midjourney', midjourneyRoutes);

// Add command-line argument support for debugging prompts
try {
  const yargs = require('yargs/yargs');
  const { hideBin } = require('yargs/helpers');
  const argv = yargs(hideBin(process.argv))
    .option('debug-prompts', {
      alias: 'd',
      type: 'boolean',
      description: 'Enable detailed logging of prompts sent to OpenAI'
    })
    .parse();

  // Set this as a global variable that can be accessed by app.js
  global.debugPrompts = argv['debug-prompts'] || false;

  // Log debug setting
  if (global.debugPrompts) {
    console.log('\x1b[32m%s\x1b[0m', '🔍 PROMPT DEBUGGING ENABLED: All OpenAI prompts will be logged to prompt_logs directory');
  }
} catch (error) {
  console.warn('Warning: Failed to initialize yargs for command line parsing. Debug prompt option is disabled.');
  console.warn('Error:', error.message);
  global.debugPrompts = false;
}


// Create the recipe_images directory if it doesn't exist
const recipesImagesDir = path.join(__dirname, 'recipe_images');
if (!fs.existsSync(recipesImagesDir)) {
  fs.mkdirSync(recipesImagesDir, { recursive: true });
}

// Serve recipe images
app.use('/recipe_images', express.static(recipesImagesDir));


// Add this middleware to set global website context
app.use((req, res, next) => {
  // Set global currentWebsiteId if it exists in session
  if (req.session && req.session.currentWebsiteId) {
    global.currentWebsiteId = req.session.currentWebsiteId;
  }
  next();
});

app.use(require('./middleware/website-auth').attachWebsiteToRequest);
app.use(require('./middleware/website-auth').getUserWebsites);

// First, import the middleware module
const websiteMiddleware = require('./middleware/website-auth');

// Check if the expected middleware functions exist
console.log('Available middleware functions:', Object.keys(websiteMiddleware));



// Then use only what's available
if (websiteMiddleware.attachWebsiteToRequest) {
  app.use(websiteMiddleware.attachWebsiteToRequest);
}

if (websiteMiddleware.getUserWebsites) {
  app.use(websiteMiddleware.getUserWebsites);
}

if (websiteMiddleware.checkWebsiteSetup) {
  app.use(websiteMiddleware.checkWebsiteSetup);
}


// THEN add website routes
const websiteRoutes = require('./website-routes');
app.use(websiteRoutes);

// Fix the middleware order - CRITICAL CHANGE
app.use(require('./middleware/auth').attachOrganizationToRequest);
app.use(fixAttachUserToLocals);
app.use(require('./middleware/auth').adminOnlyPages);





// Check API key middleware should come after authentication
app.use(checkApiKeyMiddleware);


// GET route for user add page
app.get('/users/add', isAuthenticated, isAdmin, (req, res) => {
  res.render('user-add', {
    pageTitle: 'Add User',
    activePage: 'users',
    title: 'RecipeGen AI - Add User'
  });
});

// Additional endpoints to add to your server.js file for queue management

// Import the image queue service
const imageQueueService = require('./services/image-queue-service');

// === QUEUE MANAGEMENT ROUTES ===
// Add these routes to your server.js file

// Queue status page (accessible to authenticated users)
app.get('/image-queue', isAuthenticated, (req, res) => {
  res.render('image-queue-status', {
    pageTitle: 'Image Generation Queue',
    activePage: 'image-queue',
    title: 'RecipeGen AI - Image Queue Status'
  });
});

// API endpoint to get detailed queue information
app.get('/api/image-queue/status', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const organizationId = req.session.user.organizationId;
    
    // Get user's queue status
    const queueStatus = await imageQueueService.getQueueStatus(userId, organizationId);
    
    // Get overall system stats (for admins)
    let systemStats = null;
    if (req.session.user.role === 'admin') {
      try {
        const { getAll, getOne } = require('./db');
        
        // Get system-wide queue statistics
        const stats = await getAll(`
          SELECT 
            status,
            COUNT(*) as count,
            AVG(CASE 
              WHEN completed_at IS NOT NULL AND started_at IS NOT NULL 
              THEN (julianday(completed_at) - julianday(started_at)) * 24 * 60 * 60 
            END) as avg_processing_time_seconds
          FROM image_queue 
          WHERE created_at > datetime('now', '-24 hours')
          GROUP BY status
        `);
        
        // Get recent activity
        const recentActivity = await getAll(`
          SELECT iq.*, r.recipe_idea, u.name as user_name
          FROM image_queue iq
          LEFT JOIN recipes r ON iq.recipe_id = r.id
          LEFT JOIN users u ON iq.user_id = u.id
          WHERE iq.organization_id = ?
          ORDER BY iq.created_at DESC
          LIMIT 10
        `, [organizationId]);
        
        systemStats = {
          stats: stats,
          recentActivity: recentActivity
        };
      } catch (statsError) {
        console.error('Error getting system stats:', statsError);
      }
    }
    
    res.json({
      success: true,
      ...queueStatus,
      systemStats: systemStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to cancel a queued job
app.post('/api/image-queue/cancel/:jobId', isAuthenticated, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const userId = req.session.user.id;
    
    const result = await imageQueueService.cancelJob(jobId, userId);
    
    if (result.success) {
      res.json({
        success: true,
        message: result.message
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.message
      });
    }
  } catch (error) {
    console.error('Error cancelling job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to add a recipe to the image generation queue
app.post('/api/image-queue/add', isAuthenticated, async (req, res) => {
  try {
    const { recipeId, customPrompt } = req.body;
    
    if (!recipeId) {
      return res.status(400).json({
        success: false,
        error: 'Recipe ID is required'
      });
    }
    
    // Validate recipe exists and user has access
    const recipe = await getOne("SELECT * FROM recipes WHERE id = ?", [recipeId]);
    if (!recipe) {
      return res.status(404).json({
        success: false,
        error: 'Recipe not found'
      });
    }
    
    // Check user permissions
    const orgId = req.session.user.organizationId;
    const userId = req.session.user.role === 'employee' ? req.session.user.id : null;
    
    if (recipe.organization_id !== orgId || 
        (userId && recipe.owner_id !== userId)) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to generate images for this recipe'
      });
    }
    
    // Check for existing pending job
    const existingJob = await getOne(`
      SELECT * FROM image_queue 
      WHERE recipe_id = ? AND status IN ('queued', 'processing')
    `, [recipeId]);
    
    if (existingJob) {
      return res.json({
        success: false,
        error: 'This recipe already has a pending image generation',
        existingJob: {
          id: existingJob.id,
          position: existingJob.position,
          estimatedCompletion: existingJob.estimated_completion
        }
      });
    }
    
    // Get Discord settings
    const discordSettings = global.getCurrentDiscordSettings ? 
      global.getCurrentDiscordSettings(req) : null;
    
    if (!discordSettings || !discordSettings.enableDiscord) {
      return res.status(400).json({
        success: false,
        error: 'Discord integration is not configured. Please check your settings.'
      });
    }
    
    // Add to queue
    const queueResult = await imageQueueService.addToQueue({
      recipeId: parseInt(recipeId),
      userId: req.session.user.id,
      organizationId: req.session.user.organizationId,
      websiteId: req.session.currentWebsiteId,
      customPrompt: customPrompt || null,
      discordSettings: discordSettings
    });
    
    res.json({
      success: true,
      message: 'Recipe added to image generation queue successfully',
      job: {
        id: queueResult.jobId,
        position: queueResult.position,
        estimatedCompletion: queueResult.estimatedCompletion,
        queueLength: queueResult.queueLength
      }
    });
    
  } catch (error) {
    console.error('Error adding to queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin-only endpoint to get detailed queue statistics
app.get('/api/admin/image-queue/stats', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { getAll, getOne } = require('./db');
    
    // Get comprehensive queue statistics
    const stats = await getAll(`
      SELECT 
        status,
        COUNT(*) as count,
        AVG(CASE 
          WHEN completed_at IS NOT NULL AND started_at IS NOT NULL 
          THEN (julianday(completed_at) - julianday(started_at)) * 24 * 60 * 60 
        END) as avg_processing_time_seconds,
        MIN(created_at) as earliest_job,
        MAX(created_at) as latest_job
      FROM image_queue 
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY status
    `);
    
    // Get user statistics
    const userStats = await getAll(`
      SELECT 
        u.name,
        COUNT(*) as total_jobs,
        COUNT(CASE WHEN iq.status = 'completed' THEN 1 END) as completed_jobs,
        COUNT(CASE WHEN iq.status = 'failed' THEN 1 END) as failed_jobs,
        AVG(CASE 
          WHEN iq.completed_at IS NOT NULL AND iq.started_at IS NOT NULL 
          THEN (julianday(iq.completed_at) - julianday(iq.started_at)) * 24 * 60 * 60 
        END) as avg_processing_time
      FROM image_queue iq
      JOIN users u ON iq.user_id = u.id
      WHERE iq.created_at > datetime('now', '-7 days')
        AND iq.organization_id = ?
      GROUP BY u.id, u.name
      ORDER BY total_jobs DESC
    `, [req.session.user.organizationId]);
    
    // Get recent failures with details
    const recentFailures = await getAll(`
      SELECT iq.*, r.recipe_idea, u.name as user_name
      FROM image_queue iq
      LEFT JOIN recipes r ON iq.recipe_id = r.id
      LEFT JOIN users u ON iq.user_id = u.id
      WHERE iq.status = 'failed' 
        AND iq.organization_id = ?
        AND iq.created_at > datetime('now', '-24 hours')
      ORDER BY iq.created_at DESC
      LIMIT 20
    `, [req.session.user.organizationId]);
    
    // Get performance metrics
    const performanceMetrics = await getOne(`
      SELECT 
        COUNT(*) as total_jobs_today,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_today,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_today,
        COUNT(CASE WHEN status IN ('queued', 'processing') THEN 1 END) as active_jobs,
        ROUND(
          100.0 * COUNT(CASE WHEN status = 'completed' THEN 1 END) / 
          NULLIF(COUNT(CASE WHEN status IN ('completed', 'failed') THEN 1 END), 0), 
          2
        ) as success_rate_percent
      FROM image_queue 
      WHERE created_at > datetime('now', '-24 hours')
        AND organization_id = ?
    `, [req.session.user.organizationId]);
    
    res.json({
      success: true,
      stats: {
        byStatus: stats,
        byUser: userStats,
        performance: performanceMetrics,
        recentFailures: recentFailures
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error getting admin queue stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin-only endpoint to manage queue (pause/resume, clear failed jobs, etc.)
app.post('/api/admin/image-queue/manage', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { action, jobIds } = req.body;
    
    switch (action) {
      case 'clear_failed':
        const clearResult = await runQuery(`
          DELETE FROM image_queue 
          WHERE status = 'failed' 
            AND organization_id = ? 
            AND created_at < datetime('now', '-24 hours')
        `, [req.session.user.organizationId]);
        
        res.json({
          success: true,
          message: `Cleared ${clearResult.changes || 0} failed jobs`,
          clearedCount: clearResult.changes || 0
        });
        break;
        
      case 'clear_completed':
        const clearCompletedResult = await runQuery(`
          DELETE FROM image_queue 
          WHERE status = 'completed' 
            AND organization_id = ? 
            AND created_at < datetime('now', '-7 days')
        `, [req.session.user.organizationId]);
        
        res.json({
          success: true,
          message: `Cleared ${clearCompletedResult.changes || 0} completed jobs`,
          clearedCount: clearCompletedResult.changes || 0
        });
        break;
        
      case 'retry_failed':
        if (!jobIds || !Array.isArray(jobIds)) {
          return res.status(400).json({
            success: false,
            error: 'Job IDs array is required for retry action'
          });
        }
        
        // Reset failed jobs to queued status
        const retryResult = await runQuery(`
          UPDATE image_queue 
          SET status = 'queued', 
              error_message = NULL,
              retry_count = retry_count + 1,
              position = (SELECT MAX(position) FROM image_queue WHERE status IN ('queued', 'processing')) + 1,
              estimated_completion = datetime('now', '+' || (SELECT MAX(position) FROM image_queue WHERE status IN ('queued', 'processing')) * 90 || ' seconds')
          WHERE id IN (${jobIds.map(() => '?').join(',')}) 
            AND status = 'failed'
            AND organization_id = ?
        `, [...jobIds, req.session.user.organizationId]);
        
        res.json({
          success: true,
          message: `Retried ${retryResult.changes || 0} failed jobs`,
          retriedCount: retryResult.changes || 0
        });
        break;
        
      default:
        res.status(400).json({
          success: false,
          error: 'Invalid action. Supported actions: clear_failed, clear_completed, retry_failed'
        });
    }
    
  } catch (error) {
    console.error('Error managing queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint to get queue health status
app.get('/api/image-queue/health', isAuthenticated, async (req, res) => {
  try {
    const { getOne } = require('./db');
    
    // Check for stuck jobs (processing for more than 10 minutes)
    const stuckJobs = await getOne(`
      SELECT COUNT(*) as count
      FROM image_queue 
      WHERE status = 'processing' 
        AND started_at < datetime('now', '-10 minutes')
    `);
    
    // Check queue size
    const queueSize = await getOne(`
      SELECT COUNT(*) as count
      FROM image_queue 
      WHERE status = 'queued'
    `);
    
    // Check recent failure rate
    const recentStats = await getOne(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM image_queue 
      WHERE created_at > datetime('now', '-1 hour')
    `);
    
    const failureRate = recentStats.total > 0 ? 
      (recentStats.failed / recentStats.total) * 100 : 0;
    
    // Determine health status
    let healthStatus = 'healthy';
    let issues = [];
    
    if (stuckJobs.count > 0) {
      healthStatus = 'warning';
      issues.push(`${stuckJobs.count} jobs appear to be stuck`);
    }
    
    if (queueSize.count > 20) {
      healthStatus = 'warning';
      issues.push(`Queue is large (${queueSize.count} jobs)`);
    }
    
    if (failureRate > 50) {
      healthStatus = 'critical';
      issues.push(`High failure rate (${failureRate.toFixed(1)}%)`);
    }
    
    res.json({
      success: true,
      health: {
        status: healthStatus,
        issues: issues,
        metrics: {
          stuckJobs: stuckJobs.count,
          queueSize: queueSize.count,
          recentFailureRate: Math.round(failureRate * 100) / 100
        }
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error checking queue health:', error);
    res.json({
      success: false,
      health: {
        status: 'error',
        issues: ['Unable to check queue health'],
        error: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});

// WebSocket or Server-Sent Events for real-time updates (optional enhancement)
app.get('/api/image-queue/events', isAuthenticated, (req, res) => {
  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  const userId = req.session.user.id;
  const organizationId = req.session.user.organizationId;
  
  // Send initial status
  const sendUpdate = async () => {
    try {
      const status = await imageQueueService.getQueueStatus(userId, organizationId);
      const data = JSON.stringify(status);
      res.write(`data: ${data}\n\n`);
    } catch (error) {
      console.error('Error sending SSE update:', error);
    }
  };
  
  // Send updates every 5 seconds
  const interval = setInterval(sendUpdate, 5000);
  
  // Send initial update
  sendUpdate();
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
  });
});

// === END OF QUEUE MANAGEMENT ROUTES ===

// Don't forget to also create the EJS view file for the queue status page
// Create: views/image-queue-status.ejs with the HTML content from the previous artifact

// POST route for adding user (edit this in server.js)
app.post('/users/add', isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log('User add form submitted:', req.body); // Add this line
    
    const { name, email, username, password, role } = req.body;
    
    // Validate required fields
    if (!name || !email || !username || !password || !role) {
      req.session.errorMessage = 'All fields are required.';
      return res.redirect('/users/add');
    }
    
    // Create user - Make sure this actually calls the database function
    const userId = await userDb.createUser({
      name,
      email,
      username, 
      password,
      role,
      organizationId: req.session.user.organizationId
    });
    
    if (userId) {
      req.session.successMessage = 'User created successfully';
      return res.redirect('/users');
    } else {
      req.session.errorMessage = 'Failed to create user';
      return res.redirect('/users/add');
    }
  } catch (error) {
    console.error('Error creating user:', error);
    req.session.errorMessage = 'Failed to create user: ' + error.message;
    return res.redirect('/users/add');
  }
});

// IMPORTANT: Mount routes properly
app.use('/', registrationRoutes);  // Add this line FIRST
app.use('/', authRoutes);

// Add this code to server.js right after your imports
// It will create a safer version of the getFilteredContent function that catches errors for missing tables

// Add this helper function at the beginning of server.js (after imports)
async function getFilteredContent(organizationId, employeeId = null, contentType = 'all') {
  let content = [];
  
  // Filter by owner if specified
  const ownerFilter = employeeId ? `AND owner_id = '${employeeId}'` : '';
  
  try {
    // Get recipes if requested
    if (contentType === 'all' || contentType === 'recipe') {
      const recipes = await getAll(`
        SELECT r.id, r.recipe_idea as title, 'recipe' as type, r.created_at,
               u.name as owner_name, u.role as owner_role
        FROM recipes r
        LEFT JOIN users u ON r.owner_id = u.id
        WHERE r.organization_id = ? ${ownerFilter}
        ORDER BY r.created_at DESC
        LIMIT 20
      `, [organizationId]);
      
      content.push(...recipes);
    }
    
    // Get keywords if requested
    if (contentType === 'all' || contentType === 'keyword') {
      const keywords = await getAll(`
        SELECT k.id, k.keyword as title, 'keyword' as type, k.added_at as created_at,
               u.name as owner_name, u.role as owner_role
        FROM keywords k
        LEFT JOIN users u ON k.owner_id = u.id
        WHERE k.organization_id = ? ${ownerFilter}
        ORDER BY k.added_at DESC
        LIMIT 20
      `, [organizationId]);
      
      content.push(...keywords);
    }
    
    // Get WordPress posts if requested - use try/catch to handle missing table
    if (contentType === 'all' || contentType === 'blog') {
      try {
        // First check if the wordpress_publications table exists (this is our actual table)
        const tableCheck = await getOne(`
          SELECT name FROM sqlite_master 
          WHERE type='table' AND name='wordpress_publications'
        `);
        
        if (tableCheck) {
          // Use wordpress_publications which is the correct table
          const blogPosts = await getAll(`
            SELECT wp.id, 'WordPress Post' as title, 'blog' as type, wp.created_at,
                  r.owner_id, u.name as owner_name, u.role as owner_role
            FROM wordpress_publications wp
            JOIN recipes r ON wp.recipe_id = r.id
            LEFT JOIN users u ON r.owner_id = u.id
            WHERE r.organization_id = ? ${ownerFilter}
            ORDER BY wp.created_at DESC
            LIMIT 20
          `, [organizationId]);
          
          content.push(...blogPosts);
        }
      } catch (error) {
        console.warn('Error fetching WordPress posts (table may not exist yet):', error.message);
        // Continue without WordPress posts
      }
    }
    
    // Sort all content by creation date
    content.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    // Format dates
    content.forEach(item => {
      if (item.created_at) {
        const date = new Date(item.created_at);
        item.created_at = date.toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'short', 
          day: 'numeric' 
        });
      }
    });
    
    return { success: true, content: content.slice(0, 20) };
  } catch (error) {
    console.error('Error getting filtered content:', error);
    return { success: false, message: 'Failed to load filtered content', error: error.message };
  }
}

// Default prompts configuration
let promptConfig = {
  model: process.env.DEFAULT_MODEL || 'gpt-4-turbo-preview',
  temperature: parseFloat(process.env.DEFAULT_TEMPERATURE || '0.7'),
  apiKey: process.env.OPENAI_API_KEY,
  language: process.env.DEFAULT_LANGUAGE || 'English',
  pinCount: parseInt(process.env.DEFAULT_PIN_COUNT || '10'),
  

  prompts: {
    pinTitleSystem: process.env.PIN_TITLE_SYSTEM_PROMPT || `You are a copywriting expert specialized in Pinterest Pin titles. Your task is to generate 10 different Pinterest titles for each keyword or idea, using proven high-conversion techniques.

Title formats:

Title 1: Clear & Concise Titles
Delivering the recipe's value in a straightforward way helps users instantly understand what to expect.
Example: Easy Chicken Alfredo Pasta Recipe

Title 2: Curiosity Titles
Creating a sense of intrigue encourages readers to click and discover the secret, twist, or surprise behind the recipe.
Example: The Secret to Fluffy Pancakes Everyone Gets Wrong

Title 3: Number-Based Titles
Using numbers adds structure and specificity, making the post feel scannable and promising actionable takeaways.
Example: 5 Quick Air Fryer Chicken Recipes for Busy Weeknights

Title 4: "How-To" / Instructional Titles
These titles promise a clear, step-by-step guide, appealing to readers seeking specific instructions.
Example: How to Make Perfect Japanese Soufflé Pancakes at Home

Title 5: Question-Based Titles
Posing a question piques curiosity and encourages clicks, especially when addressing common problems or desires.
Example: Craving Fluffy Pancakes? Try This Easy Soufflé Recipe!

Title 6: Mistake-Avoidance Titles
Highlighting common errors and how to avoid them can attract readers looking to improve their skills.
Example: Avoid These 5 Common Mistakes When Making Soufflé Pancakes

Title 7: Ultimate Guide / Comprehensive Titles
Offering an all-in-one resource appeals to readers seeking in-depth information.
Example: The Ultimate Guide to Making Fluffy Japanese Soufflé Pancakes

Title 8: Comparison Titles
Comparing methods or ingredients can help readers make informed choices.
Example: Soufflé Pancakes vs. Traditional Pancakes: What's the Difference?

Title 9: Seasonal or Occasion-Based Titles
Tying recipes to seasons or events can increase relevance and urgency.
Example: Spring Brunch Delight: Fluffy Soufflé Pancakes Recipe

Title 10: Trend-Focused Titles
Leveraging current trends or viral topics can boost visibility.
Example: TikTok's Viral Soufflé Pancakes: Try the Recipe Everyone's Talking About

Context:

You're helping a food & lifestyle blogger attract attention on Pinterest. Users are quickly scrolling, so your titles must stop the scroll, spark interest, and encourage saves/clicks. Titles must also help the Pin rank in Pinterest search.

Instructions:

1. Use clear and concise language — strong verbs, no fluff
2. Highlight the benefit — make the result or value obvious
3. Create curiosity — tease secrets, ask questions, or spark intrigue
4. Use numbers/lists — if the topic allows, add structure with numbers
5. Use natural language with SEO keywords front-loaded
6. Keep each title under 100 characters
7. Write in a friendly, conversational tone like a real food or home blogger

Bad vs. Good Examples:

1. Clear & Concise Titles
❌ "Chicken dinner idea" → ✅ "Easy Baked Lemon Chicken Thighs"
❌ "Soup I love" → ✅ "Creamy Tomato Basil Soup Recipe"
❌ "Slow cooker something" → ✅ "Slow Cooker Pulled Pork Sandwiches"

2. Curiosity Titles
❌ "Cool pancake recipe" → ✅ "The Secret to Fluffy Pancakes Everyone Gets Wrong"
❌ "Another slow cooker recipe" → ✅ "Why I Always Add This to My Crockpot Chicken"
❌ "Easy dessert idea" → ✅ "The 2-Ingredient Chocolate Mousse That Feels Fancy"

3. Number-Based Titles
❌ "Quick breakfast meals" → ✅ "5 Cozy Fall Breakfasts You'll Crave"
❌ "Ideas for pasta night" → ✅ "7 Easy Pasta Recipes for Busy Weeknights"
❌ "Dinner tips" → ✅ "3 Tricks for Juicier Chicken Every Time"

4. How-To / Instructional Titles
❌ "Best banana bread" → ✅ "How to Make Moist Banana Bread That Never Fails"
❌ "Easy pancakes" → ✅ "How to Make Fluffy Pancakes from Scratch"
❌ "Quick salad idea" → ✅ "How to Build the Perfect Summer Salad in 10 Minutes"

5. Question Titles
❌ "Try these meatballs" → ✅ "Can You Make Meatballs Without Breadcrumbs?"
❌ "Tips for baking bread" → ✅ "Is Homemade Bread Really Worth It?"
❌ "Taco recipe here" → ✅ "What's the Secret to the Best Taco Tuesday?"

6. Mistake-Avoidance Titles
❌ "Bread baking tips" → ✅ "Avoid These 5 Mistakes When Baking Bread"
❌ "How to roast chicken" → ✅ "Stop Doing This When Roasting a Whole Chicken"
❌ "Make better cookies" → ✅ "Why Your Cookies Turn Out Flat — And How to Fix Them"

7. Ultimate Guide Titles
❌ "Soufflé recipe" → ✅ "The Ultimate Guide to Making Soufflé Pancakes at Home"
❌ "Baking bread" → ✅ "Beginner's Guide to Homemade Sourdough"
❌ "Meal prep" → ✅ "The Ultimate 7-Day Meal Prep Plan for Busy Families"

8. Comparison Titles
❌ "Soup recipe" → ✅ "Instant Pot vs. Crockpot: Which Makes Better Chicken Soup?"
❌ "Smoothie vs juice" → ✅ "Green Smoothies vs. Juices: Which Is Healthier?"
❌ "Microwave vs oven" → ✅ "Microwave Mug Cakes vs. Oven-Baked: What's the Real Difference?"

9. Seasonal / Occasion-Based Titles
❌ "Apple pie recipe" → ✅ "Cozy Fall Apple Pie with Maple Crust"
❌ "Some Thanksgiving food" → ✅ "Easy Thanksgiving Sides to Impress Your Guests"
❌ "Soup idea" → ✅ "Winter Comfort: Creamy Chicken Noodle Soup"

10. Trend-Focused Titles
❌ "Cool new recipe" → ✅ "TikTok's Viral Grinder Salad Sandwich — Worth the Hype?"
❌ "What's popular now" → ✅ "These Butter Boards Are Taking Over Pinterest"
❌ "Soup trend" → ✅ "Cottage Cheese Ice Cream: What Happens When You Try It?"`,
    
    pinTitleUser: process.env.PIN_TITLE_USER_PROMPT || `Recipe Idea: {{recipeIdea}}
Language: {{language}}
Please generate {{pinCount}} different Pinterest Pin titles that follow the formatting and guidance provided in the system prompt. Use the keyword, interests, and recipe idea to create attention-grabbing, high-conversion titles. 
Return only the final text without any numbering, dashes, labels, or quotation marks. Do not include "Title 1:", "1.", "-", or any symbols. Just plain clean text.`,
    
    pinDescSystem: process.env.PIN_DESC_SYSTEM_PROMPT || `You are a Pinterest marketing and copywriting expert. Your task is to generate highly effective Pinterest Pin descriptions for blog post Pins that maximize engagement and click-throughs. Each description must serve both the Pinterest algorithm and real human readers.
Follow these strict principles:
1. Start with relevant, **front-loaded keywords** based on the Pin topic — what users are likely to search
2. Use **natural, conversational language** (like friendly advice from a blogger)
3. Be **clear and benefit-driven** — what problem does this Pin solve or what value does it offer?
4. Add a **a natural, benefit-focused nudge that encourages action without sounding pushy** (e.g., "Don't be surprised if this becomes your new favorite" or "A cozy dinner idea worth trying this week")
5. End with **2–3 relevant broad hashtags** (max) that match Pinterest SEO best practices
6. Keep each description between **100–200 characters**
Tone: Warm, helpful, modern. You are writing for American women home cooks or lifestyle lovers.
Bad vs Good examples (with indirect CTAs):
❌ "Here's a pin about meal prep ideas for the week"
✅ "Meal prep just got easier with these 5 make-ahead dinners for busy nights. One to keep in your weekly rotation. #mealprep #weeknightmeals"
❌ "How to make fall wreaths"
✅ "Learn how to make a beautiful fall wreath in under 30 minutes — a cozy DIY project you'll want to recreate. #fallwreath #diyhomedecor"
Always output:
- 1 Pinterest-optimized description in 100–200 characters.`,
    
    pinDescUser: process.env.PIN_DESC_USER_PROMPT || `Pin Title: {{pinTitle}}
Category: {{category}}
Annotated Interests: {{interests}}
Language: {{language}}
Based on the instructions provided, please write {{pinCount}} different Pinterest Pin description that is optimized for both engagement and SEO. 
Return only the final text without any numbering, dashes, labels, or quotation marks. Do not include "Description 1:", "1.", "-", or any symbols. Just plain clean text.`,
    
    pinOverlaySystem: process.env.PIN_OVERLAY_SYSTEM_PROMPT || `You are a Pinterest marketing and visual copy expert. Your task is to create short, scroll-stopping overlay text for Pinterest images. This overlay should grab attention fast while sparking curiosity — using as few words as possible.
Follow these principles:
1. Use **minimal text** — 4 to 7 words max
2. **Front-load keywords** for Pinterest SEO (if relevant)
3. Focus on **benefit or transformation** — what will the viewer gain?
4. Spark **curiosity** with surprise, specificity, or urgency
5. Use **clear, bold, conversational language** — no fluff or vague words
6. Do **not** include punctuation unless it's essential (like parentheses or exclamation points)
7. No hashtags or branding
Tone: Friendly, modern, and direct — like a helpful blogger speaking to her Pinterest audience
Bad vs Good (with keyword included naturally):
❌ "My best slow cooker idea ever!" ✅ "Slow Cooker Chicken That Falls Apart"
❌ "Some fall organizing tips" ✅ "Fall Closet Organization Made Simple"
❌ "Ways to save money" ✅ "Save Big on Your Weekly Grocery Bill"
❌ "Tasty dinner tonight?" ✅ "Easy Crockpot Chicken Tacos Tonight"
❌ "Meal prep goals!" ✅ "Vegan Meal Prep You'll Actually Love"
Always return 1 short overlay phrase only.`,
    
    pinOverlayUser: process.env.PIN_OVERLAY_USER_PROMPT || `Pin Title: {{pinTitle}}
Language: {{language}}
Create {{pinCount}} short Pinterest image overlay text (4–7 words max) that matches the tone and message of the Pin. Use curiosity and benefit-driven language. Keep it concise and bold. 
Return only the final text without any numbering, dashes, labels, or quotation marks. Do not include "Image 1:", "1.", "-", or any symbols. Just plain clean text.`,
    
    metaTitleSystem: process.env.META_TITLE_SYSTEM_PROMPT || `You are an SEO content strategist specializing in crafting compelling and optimized blog post titles.
Your goal is to generate one SEO-friendly blog post title that aligns with current best practices to enhance visibility in search engines and drive clicks.
Context:
The title must attract attention in search engine results pages (SERPs), accurately represent the blog post content, and include the keyword naturally.
Follow these instructions:
- Incorporate the Primary Keyword: Include the main keyword, ideally at the beginning.
- Match Search Intent: Understand what the user is looking for and reflect that in the title.
- Be Descriptive and Concise: Clearly express the value of the post in 50–60 characters.
- Avoid Keyword Stuffing: Use keywords naturally — no repetition or awkward phrasing.
- Use Power Words and Numbers: Include numbers, brackets, or compelling phrases to increase click-through rates (e.g. "10 Easy Tips", "[2025]", "Best", etc.).
Constraints:
- Character Limit: Maximum of 60 characters
- Tone: Professional, clear, and engaging
- Avoid misleading or clickbait titles
Bad vs Good Examples:
1. Clear & Concise
❌ Poor: "A Great Dinner Recipe I Love" ✅ Good: Easy Slow Cooker Chicken Tacos
❌ Poor: "Make This Dish Tonight" ✅ Good: Creamy Garlic Mashed Potatoes Recipe
2. Curiosity-Based
❌ Poor: "This Might Be the Best Chicken Ever" ✅ Good: The Secret to the Best Slow Cooker Chicken
❌ Poor: "Wow—Just Try This Pasta" ✅ Good: Why Everyone's Talking About This Pasta Bake
3. Number-Based
❌ Poor: "Tasty Dinners to Try" ✅ Good: 5 Quick Weeknight Dinners to Try Now
❌ Poor: "Ideas for Soups" ✅ Good: 7 Cozy Fall Soups You Can Freeze
4. How-To / Instructional
❌ Poor: "Making Pancakes Like This Is Fun" ✅ Good: How to Make Fluffy Japanese Soufflé Pancakes
❌ Poor: "Roast Chicken Is Easy If You Know How" ✅ Good: How to Roast Chicken Perfectly Every Time
5. Question-Based
❌ Poor: "Thinking of Prepping Chicken?" ✅ Good: What's the Best Way to Meal Prep Chicken?
❌ Poor: "No Eggs? Try This" ✅ Good: Can You Bake a Cake Without Eggs?
6. Mistake-Avoidance
❌ Poor: "Bread Didn't Turn Out?" ✅ Good: 5 Mistakes That Ruin Banana Bread
❌ Poor: "Watch Out When You Slow Cook" ✅ Good: Avoid These Slow Cooker Chicken Fails
7. Ultimate Guide
❌ Poor: "Learn Everything About Chicken Recipes" ✅ Good: The Ultimate Guide to Slow Cooker Chicken
❌ Poor: "How to Meal Prep All Week" ✅ Good: Complete Guide to Keto Meal Prep for Beginners
8. Comparison
❌ Poor: "Different Cooking Appliances Compared" ✅ Good: Air Fryer vs. Oven: Which Cooks Faster?
❌ Poor: "Quinoa or Rice—You Decide" ✅ Good: Quinoa vs. Rice: Which Is Better for Meal Prep?
9. Seasonal / Occasion-Based
❌ Poor: "Holiday Brunch Recipe Ideas" ✅ Good: Easy Christmas Brunch Ideas Everyone Will Love
❌ Poor: "Dinner Ideas for Autumn" ✅ Good: Cozy Fall Dinner Recipes for Chilly Nights
10. Trend-Focused
❌ Poor: "The Newest Internet Food Thing" ✅ Good: TikTok's Viral Baked Oats: Worth the Hype?
❌ Poor: "This Ice Cream Is Weird But Cool" ✅ Good: Try This Pinterest-Famous Cottage Cheese Ice Cream
Return only one SEO-optimized blog post title.`,
    
    metaTitleUser: process.env.META_TITLE_USER_PROMPT || `Pinterest Pin title: {{pinTitle}}
Language: {{language}}
Please generate 1 SEO blog post title that follows the instructions provided in the system prompt. Make it optimized for search, aligned with the pin title, and under 60 characters. 
Return only the final text without any numbering, dashes, labels, or quotation marks. Do not include "Title 1:", "1.", "-", or any symbols. Just plain clean text.`,
    
    metaDescSystem: process.env.META_DESC_SYSTEM_PROMPT || `You are an SEO content strategist specializing in crafting compelling meta descriptions that enhance search engine visibility and click-through rates. Your goal is to generate an SEO-friendly meta description that accurately summarizes a blog post or webpage and entices users to click.
Context:
The description should align with the page's actual content, include relevant keywords naturally, and appeal to the target audience's search intent.
Follow these instructions:
- Optimal Length: Keep the meta description between 120–155 characters so it displays properly in Google results.
- Incorporate Target Keywords: Use the primary keyword naturally and early in the sentence.
- Use Active Voice and Action-Oriented Language: Engage the reader with direct, clear phrasing.
- Gently guide the reader toward clicking by hinting at the value of the content. Instead of direct commands, use friendly phrasing that suggests what they'll gain or enjoy. Encourage clicks with phrases like "A must-try if you love quick, comforting meals" "Discover," "Perfect for your next cozy dinner at home" or "The kind of recipe that saves busy weeknights."
- Ensure Uniqueness: Every description must be unique and not duplicated from other pages.
- Reflect Page Content Accurately: Ensure the summary represents what the post truly offers.
Constraints:
- Character Limit: Maximum of 155 characters
- Tone: Professional, helpful, and engaging
- Avoid keyword stuffing or vague language
Bad vs Good Examples:
1. Clear & Concise Titles
❌ Poor: "This blog post is about chicken tacos and how to cook them." ✅ Good: "Make these easy slow cooker chicken tacos with simple pantry staples — perfect for a no-fuss dinner everyone will love."
2. Curiosity-Based Titles
❌ Poor: "This recipe is a surprise and very good. You should try it." ✅ Good: "The secret to juicy, flavor-packed chicken is easier than you think — one you'll want to make again and again."
3. Number-Based Titles
❌ Poor: "Here are some recipes to try for dinner or lunch." ✅ Good: "Try these 5 quick dinner ideas that make busy weeknights feel a little easier — no fancy ingredients required."
4. How-To Titles
❌ Poor: "Learn about making pancakes with steps to follow." ✅ Good: "Follow this step-by-step guide to fluffy soufflé pancakes — soft, jiggly, and ready to impress."
5. Question-Based Titles
❌ Poor: "This blog post will answer your question about baking a cake." ✅ Good: "Wondering how to bake a cake without eggs? This easy recipe has you covered with simple swaps and delicious results."
6. Mistake-Avoidance Titles
❌ Poor: "Here are some mistakes to avoid when cooking." ✅ Good: "Avoid these common bread-baking mistakes to get soft, golden loaves every time — great if you're just starting out."
7. Ultimate Guide Titles
❌ Poor: "Everything you need to know is in this blog post." ✅ Good: "This ultimate slow cooker chicken guide has everything you need — from tips to variations and serving ideas."
8. Comparison Titles
❌ Poor: "This post compares two different cooking methods." ✅ Good: "Not sure if the air fryer or oven is better? This comparison breaks it down with time, texture, and taste in mind."
9. Seasonal / Occasion-Based Titles
❌ Poor: "Recipes for the holidays and other times of the year." ✅ Good: "Warm up your table with these cozy fall dinner recipes — easy comfort food perfect for chilly nights."
10. Trend-Focused Titles
❌ Poor: "Try this trending recipe from the internet." ✅ Good: "This TikTok-famous baked oats recipe is easy, wholesome, and totally worth the hype."
Return only one SEO-optimized meta description.`,
    
    metaDescUser: process.env.META_DESC_USER_PROMPT || `Pinterest Pin title: {{pinTitle}}
Pinterest Pin description: {{pinDesc}}
Language: {{language}}
Please generate 1 SEO meta description that aligns with this Pin's topic. Follow the system instructions to optimize for both search and click-throughs. 
Return only the final text without any numbering, dashes, labels, or quotation marks. Do not include "Title 1:", "1.", "-", or any symbols. Just plain clean text.`,
    
    slugSystemPrompt: process.env.SLUG_SYSTEM_PROMPT || `You are an SEO specialist. Your task is to generate a short, clean, and keyword-optimized blog post slug based on the provided meta title and recipe idea.
Slug Format Rules:
- Use only lowercase letters
- Replace spaces with hyphens (kebab-case)
- Use 3 to 6 important words only (max ~60 characters total)
- Include 1 or 2 primary keywords from the title or recipe idea
- Remove stopwords like "a", "the", "and", "to", "with", "of", etc.
- Do NOT include domain names, slashes, or punctuation
- Match the title's core idea, but keep it short and search-friendly
Output Requirements:
Return only the final slug (no quotes, no formatting, no label).`,
    
    slugUserPrompt: process.env.SLUG_USER_PROMPT || `Recipe Idea: {{recipeIdea}}  
Meta Title: {{metaTitle}}
Please generate a short, SEO-optimized blog post slug based on the title and keyword.`,
    
    blogpostSystemPrompt: process.env.BLOGPOST_SYSTEM_PROMPT || `You are a food blogger and SEO content strategist writing for the brand Wanda Recipes.
Tone & Brand Voice:
- Audience: American women who love quick, easy, homemade meals
- Tone: Friendly, informative, and encouraging — like chatting with a friend in the kitchen
- Guidelines: Use warm, clear language. Avoid jargon. Be helpful, real, and supportive. Make readers feel at home and inspired to try the recipe.
Your task is to write a fully SEO-optimized blog post for a recipe based on the following inputs: meta title, meta description, category, and annotated interest.
Write with search performance and readability in mind. The blog post should rank well on Google and delight readers.
🧠 CONTENT STRUCTURE:
Write a blog post using this structure, but DO NOT repeat these section headers literally. Instead, optimize all section titles dynamically for SEO and clarity.
1. **INTRODUCTION**
   - Begin with a friendly hook that draws the reader in
   - Include the primary keyword naturally in the first 1–2 sentences
   - Add a personal anecdote or story to build trust and relatability
3. **INGREDIENTS**
   - Break into clear bullet points
   - Provide brief, helpful tips where relevant
   - Mention tools needed for success
4. **STEP-BY-STEP INSTRUCTIONS** 
   - Use numbered steps  
   - Each step should begin with a short, clear title (like a mini heading) to guide the reader (e.g., "1. Whisk the Batter" or "3. Flip and Cook")  
   - Follow the title with a beginner-friendly explanation  
   - Add casual encouragement, helpful tips, or notes if relevant (e.g., "Don't worry if it looks messy here — that's normal!")  
5. **FREQUENTLY ASKED QUESTIONS**
   - Include 4–5 questions your audience might Google
   - Answer clearly and supportively in Wanda's voice
6. **CLOSING / CALL-TO-ACTION**
   - Wrap up with encouragement to try the recipe
   - Suggest sharing on Pinterest or tagging on social
   - Include a soft, warm sign-off like a kitchen friend would use
---
🔍 SEO REQUIREMENTS (Based on Semrush Best Practices):
- Use the **meta title** as the blog post's H1
- Include the **primary keyword** within the first 100 words
- Naturally include **secondary keywords** (if implied in annotated interest)
- Use proper **H2 and H3 subheadings** with relevant keywords
- Incorporate **internal links** (if relevant) and **external links** to reputable sources
- Include **image suggestions** or alt text phrases with keywords
- Ensure content length is 800–1,200 words
- Avoid keyword stuffing, clickbait, or robotic phrasing
---
📋 OUTPUT RULES:
- Use SEO-optimized section headings based on the content and recipe keyword but write them as plain text — do NOT use markdown symbols like \`##\`, \`**\`, or numbers
- Format all headings as plain lines of text above their paragraph (e.g., "Why You'll Love This Recipe")
- Do NOT repeat or copy the outline structure or headings from the system prompt
- Do NOT use any markdown, HTML, or numbered formatting
- Return ONLY clean, human-readable blog content ready to copy into WordPress
---
Return **only the blog post content**. Do not include markdown or HTML. Format it as plain, publish-ready text.`,
    
    blogpostUserPrompt: process.env.BLOGPOST_USER_PROMPT || `Please write a full SEO-optimized blog post for the following recipe topic:
Recipe Idea (Main Keyword): {{recipeIdea}}  
Meta Title: {{metaTitle}}  
Meta Description: {{metaDescription}}  
Category: {{category}}  
Annotated Interests: {{interests}}
Language: {{language}}
Do not repeat or label the sections — just use helpful headings and clean, natural text.  
Avoid any markdown symbols, numbers, or bold/italic styles.  
Return only the final blog content as plain text.
Use the blog structure and tone described in the system prompt.  
Do not include outline labels or formatting (no bold, headings, asterisks, or HTML).  
Return **only the blog content** as clean, plain text.  
Make it copy-paste ready for WordPress.
Follow the blog structure and tone described in the system prompt but rewrite section headings dynamically with SEO-friendly, benefit-focused language. Return only the blog post content as clean, publish-ready plain text. Do not include markdown, bullet formatting symbols, or explanations — just the blog content.`,
    
    fbPrompt: process.env.FB_PROMPT || `Create a complete recipe for {{recipeIdea}} in {{language}}. Include:
1. An emoji and title at the beginning
2. A brief introduction (2-3 sentences)
3. Ingredients section with emoji 🧂 and ingredients listed with bullet points
4. Preparation section with emoji 🧑‍🍳 and numbered steps
5. A cooking tip at the end

Be detailed but concise, and ensure the recipe is delicious and practical.`,
    
    mjTemplate: process.env.MJ_TEMPLATE || `Professional food photography of {{title}}, ingredients include {{ingredients}}, photo taken with a Canon EOS R5, 85mm lens, f/2.8, natural lighting, food styling, shallow depth of field, mouth-watering, magazine quality, top view, soft shadows, textured wood or marble background, garnished beautifully`,
    
    fbCaptionPrompt: process.env.FB_CAPTION_PROMPT || `Create an engaging Facebook post caption for this recipe in {{language}}. The caption should be conversational, include 2-3 emojis, ask an engaging question, and invite comments. Keep it under 150 words and make sure it entices people to try the recipe. Here's the recipe:

{{recipe}}`
  }
};

// Make the moment library available to templates
app.locals.moment = moment;

// Home page - now shows recent recipes
// Home page - now shows recent recipes with organization filtering
// Home page - now shows recent recipes with organization filtering and activity statistics
app.get('/', isAuthenticated, async (req, res) => {
  try {
    // Get organization ID from session
    const organizationId = req.session.user.organizationId;
    const userId = req.session.user.role === 'employee' ? req.session.user.id : null;
    const isAdmin = req.session.user.role === 'admin';
    
    // Collect dashboard statistics
    const dashboardStats = {
      recipes: 0,
      pendingKeywords: 0,
      processedKeywords: 0,
      failedKeywords: 0,
      totalKeywords: 0,
      wordpressPosts: 0,
      userCount: 0
    };
    
    // Get recent recipes filtered by organization and optionally by user
    let recentRecipes;
    if (userId) {
      // For employees, only show their recipes
      recentRecipes = await recipeDb.getRecipesByOwnerAndOrg(userId, organizationId, 10, 0);
    } else {
      // For admins, show all recipes in their organization
      recentRecipes = await recipeDb.getRecipesByOrg(organizationId, 10, 0);
    }
    
    // Gather keyword statistics
    dashboardStats.pendingKeywords = await keywordsDb.getKeywordsCount('pending', null, userId, organizationId);
    dashboardStats.processedKeywords = await keywordsDb.getKeywordsCount('processed', null, userId, organizationId);
    dashboardStats.failedKeywords = await keywordsDb.getKeywordsCount('failed', null, userId, organizationId);
    dashboardStats.totalKeywords = dashboardStats.pendingKeywords + dashboardStats.processedKeywords + dashboardStats.failedKeywords;
    
    // Get recipe count
    if (userId) {
      dashboardStats.recipes = await recipeDb.getRecipeCountByOwner(userId);
    } else {
      dashboardStats.recipes = await recipeDb.getRecipeCountByOrganization(organizationId);
    }
    
    // Get WordPress post count if we have WordPress integration
    try {
dashboardStats.wordpressPosts = await wordpressDb.getPublicationCount(userId, organizationId, req.session.currentWebsiteId);
    } catch (error) {
      console.log('No WordPress publications found or error counting them:', error.message);
    }
    
    // If admin, get user count in organization
    if (isAdmin) {
      const orgUsers = await userDb.getUsersByOrganization(organizationId);
      dashboardStats.userCount = orgUsers.length;
      
      // Get recent activity for the organization
      dashboardStats.recentActivity = await getRecentActivityLogs(organizationId, 5);
      
      // Get employee performance stats
      dashboardStats.employeeStats = await getEmployeeStats(organizationId);
    } else {
      // For employees, get their own activity
      dashboardStats.recentActivity = await getRecentActivityLogs(organizationId, 5, userId);
    }
    
    // Ensure promptConfig is properly formatted
    if (promptConfig && !promptConfig.prompts) {
      promptConfig = {
        model: promptConfig.model || 'gpt-4-turbo-preview',
        temperature: promptConfig.temperature || 0.7,
        apiKey: promptConfig.apiKey || process.env.OPENAI_API_KEY,
        language: promptConfig.language || 'English',
        pinCount: promptConfig.pinCount || 10,
        prompts: { ...promptConfig }
      };
    }
    
    res.render('index', { 
      promptConfig: promptConfig || {},
      recentRecipes,
      stats: dashboardStats,
      isAdmin: isAdmin,
      pageTitle: 'Dashboard',
      activePage: 'dashboard',
      title: 'RecipeGen AI - Dashboard'
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.render('index', { 
      promptConfig: promptConfig || {},
      recentRecipes: [],
      stats: {},
      error: 'Failed to load dashboard data: ' + error.message,
      pageTitle: 'Dashboard',
      activePage: 'dashboard',
      title: 'RecipeGen AI - Dashboard'
    });
  }
});

// Helper function to get recent activity logs
async function getRecentActivityLogs(organizationId, limit = 5, userId = null) {
  try {
    // If we don't have an activity log table yet, return empty array
    const hasActivityTable = await checkTableExists('activity_logs');
    if (!hasActivityTable) {
      return [];
    }
    
    let query = `
      SELECT al.*, u.name as user_name 
      FROM activity_logs al
      JOIN users u ON al.user_id = u.id
      WHERE al.organization_id = ?
    `;
    
    const params = [organizationId];
    
    if (userId) {
      query += ` AND al.user_id = ?`;
      params.push(userId);
    }
    
    query += ` ORDER BY al.created_at DESC LIMIT ?`;
    params.push(limit);
    
    return await getAll(query, params);
  } catch (error) {
    console.error('Error getting activity logs:', error);
    return [];
  }
}

// Helper function to get employee stats
async function getEmployeeStats(organizationId) {
  try {
    // Get all employees in the organization
    const employees = await userDb.getUsersByOrganization(organizationId);
    const employeeIds = employees.filter(u => u.role === 'employee').map(u => u.id);
    
    if (employeeIds.length === 0) {
      return [];
    }
    
    // Get stats for each employee
    const stats = [];
    
    for (const id of employeeIds) {
      const employee = employees.find(u => u.id === id);
      
      // Skip if not found (should never happen)
      if (!employee) continue;
      
      // Get counts
      const recipeCount = await recipeDb.getRecipeCountByOwner(id);
      const keywordCounts = {
        pending: await keywordsDb.getKeywordsCount('pending', null, id),
        processed: await keywordsDb.getKeywordsCount('processed', null, id),
        failed: await keywordsDb.getKeywordsCount('failed', null, id)
      };
      
      // Calculate total
      keywordCounts.total = keywordCounts.pending + keywordCounts.processed + keywordCounts.failed;
      
      // Get WordPress posts if we have WordPress integration
      let wpPostCount = 0;
      try {
        wpPostCount = await wordpressDb.getPublicationCount(id, organizationId, req.session.currentWebsiteId);
      } catch (error) {
        // Ignore error if WordPress integration not set up
      }
      
      stats.push({
        id: id,
        name: employee.name,
        email: employee.email,
        recipeCount,
        keywordCounts,
        wpPostCount,
        totalContent: recipeCount + keywordCounts.processed
      });
    }
    
    // Sort by total content in descending order
    return stats.sort((a, b) => b.totalContent - a.totalContent);
  } catch (error) {
    console.error('Error getting employee stats:', error);
    return [];
  }
}

// Helper function to check if a table exists
async function checkTableExists(tableName) {
  try {
    const result = await getOne(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [tableName]
    );
    return !!result;
  } catch (error) {
    console.error(`Error checking if table ${tableName} exists:`, error);
    return false;
  }
}

// Updated Settings Route for server.js
// Replace your existing settings GET route with this one

// Updated Settings GET Route
app.get('/settings', isAuthenticated, async (req, res) => {
  try {
    const successMessage = req.session.successMessage;
    const errorMessage = req.session.errorMessage;
    delete req.session.successMessage; // Clear the message after use
    delete req.session.errorMessage; // Clear the error message after use
    
    // Get organization ID and website ID from session
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    
    // Load website-specific settings
    const websiteSettings = promptSettingsDb.loadSettings(organizationId, websiteId);
    
    // Set to global promptConfig for backward compatibility
    promptConfig = websiteSettings;
    
    // Get API key information - force a fresh check from the database
    const openaiKey = await apiKeyManager.getApiKey('openai');
    console.log('Settings page - API key status:', openaiKey ? 'Found' : 'Not found');
    
    const apiKeys = {
      openai: openaiKey ? true : false
    };
    
    res.render('settings', { 
      promptConfig: websiteSettings || {},
      successMessage: successMessage,
      errorMessage: errorMessage,
      pageTitle: 'Prompt Settings',
      activePage: 'settings',
      title: 'RecipeGen AI - Settings',
      apiKeys: apiKeys,
      websiteId: websiteId
    });
  } catch (error) {
    console.error('Error loading settings page:', error);
    res.render('settings', { 
      promptConfig: promptConfig || {},
      successMessage: null,
      errorMessage: 'Error loading settings: ' + error.message,
      pageTitle: 'Prompt Settings',
      activePage: 'settings',
      title: 'RecipeGen AI - Settings',
      apiKeys: { openai: false },
      websiteId: req.session.currentWebsiteId
    });
  }
});

// Keywords management page with organization filtering
// Keywords management page with organization filtering - FIXED VERSION
// Keywords management page with organization filtering - FIXED VERSION
app.get('/keywords', isAuthenticated, async (req, res) => {
  try {
    // Get organization ID from session
    const organizationId = req.session.user.organizationId;
    const userId = req.session.user.role === 'employee' ? req.session.user.id : null;
    const userRole = req.session.user.role;
    
    console.log(`Loading keywords for ${userRole} (${userId}) in organization: ${organizationId}`);
    
    // Get query parameters for filtering and pagination
    const status = req.query.status || null;
    const page = parseInt(req.query.page || '1');
    const search = req.query.search || null;
    const limit = 50;
    const offset = (page - 1) * limit;

    // Get keywords with filters
    let keywords = [];
    if (userRole === 'employee') {
      // Employees only see their keywords
      keywords = await keywordsDb.getKeywordsByOwner(userId, status, limit, offset, search);
      console.log(`Retrieved ${keywords.length} keywords for employee ${userId}`);
    } else {
      // Admins see all keywords in their organization
      keywords = await keywordsDb.getKeywordsByOrganization(organizationId, status, limit, offset, search);
      console.log(`Retrieved ${keywords.length} keywords for organization ${organizationId}`);
    }
    
    // Get total count for pagination (with same filters)
    let totalCount = 0;
    if (userRole === 'employee') {
      totalCount = await keywordsDb.getKeywordsCount(status, search, userId);
    } else {
      totalCount = await keywordsDb.getKeywordsCount(status, search, null, organizationId);
    }
    
    const totalPages = Math.ceil(totalCount / limit);
    
    // Count by status for statistics
    let pendingCount = 0, processedCount = 0, failedCount = 0;
    if (userRole === 'employee') {
      pendingCount = await keywordsDb.getKeywordsCount('pending', null, userId);
      processedCount = await keywordsDb.getKeywordsCount('processed', null, userId);
      failedCount = await keywordsDb.getKeywordsCount('failed', null, userId);
    } else {
      pendingCount = await keywordsDb.getKeywordsCount('pending', null, null, organizationId);
      processedCount = await keywordsDb.getKeywordsCount('processed', null, null, organizationId);
      failedCount = await keywordsDb.getKeywordsCount('failed', null, null, organizationId);
    }
    
    res.render('keywords', {
  pageTitle: 'Keywords Management',
  activePage: 'keywords',
  title: 'RecipeGen AI - Keywords Management',
  keywords,
  currentPage: page,
  totalPages,
  totalCount,
  limit,
  status,
  search: search,  // CHANGED FROM searchTerm to search
  stats: {
    pending: pendingCount,
    processed: processedCount,
    failed: failedCount,
    total: totalCount
  }
});
  } catch (error) {
    console.error('Error loading keywords page:', error);
    res.render('error', {
      message: 'Failed to load keywords',
      error: error,
      pageTitle: 'Error',
      activePage: '',
      title: 'RecipeGen AI - Error'
    });
  }
});

app.get('/midjourney-filter-admin', isAuthenticated, isAdmin, (req, res) => {
  res.render('midjourney-filter-admin', {
    pageTitle: 'Midjourney Filter Admin',
    activePage: 'midjourney-filter-admin',
    title: 'RecipeGen AI - Midjourney Filter Admin'
  });
});

// Recipe browser page
// Recipe browser page - Updated version with limit variable
app.get('/recipes', isAuthenticated, isResourceOwner, async (req, res) => {
  try {
    // Get search parameters
    const searchTerm = req.query.search || '';
    const page = parseInt(req.query.page) || 1;
    const limit = 20; // Define the limit
    const offset = (page - 1) * limit;
    
    // Use the filters set by isResourceOwner middleware
    let recipes;
    
    if (req.session.user.role === 'employee') {
      // Employees see only their content
      if (searchTerm) {
        recipes = await recipeDb.searchRecipesByOwner(req.session.user.id, searchTerm, limit, offset);
      } else {
        recipes = await recipeDb.getRecipesByOwnerAndOrg(req.session.user.id, req.session.user.organizationId, limit, offset);
      }
    } else {
      // Admins see all org content
      if (searchTerm) {
        recipes = await recipeDb.searchRecipesInOrganization(req.session.user.organizationId, searchTerm, limit, offset);
      } else {
        recipes = await recipeDb.getRecipesByOrg(req.session.user.organizationId, limit, offset);
      }
    }
    
    res.render('recipes', { 
      recipes,
      searchTerm,
      pageTitle: 'Browse Recipes',
      activePage: 'recipes',
      title: 'RecipeGen AI - Recipe Browser',
      currentPage: page,
      totalPages: 1, // You can update this if you implement pagination
      limit: limit   // Pass the limit variable to the template
    });
  } catch (error) {
    console.error('Error loading recipes:', error);
    res.render('error', { 
      message: 'Failed to load recipes',
      error: error,
      pageTitle: 'Error',
      activePage: '',
      title: 'RecipeGen AI - Error'
    });
  }
});

app.get('/recipe/:id', isAuthenticated, async (req, res) => {
  try {
    const recipeId = req.params.id;
    
    // Get the recipe details
    const recipe = await recipeDb.getRecipeById(recipeId);
    if (!recipe) {
      return res.status(404).render('error', {
        message: 'Recipe not found',
        error: { status: 404 },
        pageTitle: 'Error',
        activePage: '',
        title: 'RecipeGen AI - Error'
      });
    }
    
    // Check if user has access to this recipe
    const orgId = req.session.user.organizationId;
    const userId = req.session.user.role === 'employee' ? req.session.user.id : null;
    
    if (recipe.organization_id !== orgId || 
        (userId && recipe.owner_id !== userId)) {
      return res.status(403).render('error', {
        message: 'You do not have permission to view this recipe',
        error: { status: 403 },
        pageTitle: 'Error',
        activePage: '',
        title: 'RecipeGen AI - Error'
      });
    }
    
    // Get the associated content
    const facebook = await facebookDb.getFacebookContentByRecipeId(
      recipeId, 
      orgId,
      userId
    );
    const pinterestVariations = await pinterestDb.getVariationsByRecipeId(recipeId);
    const blog = await blogDb.getBlogContentByRecipeId(recipeId);
    
    // NEW CODE: Fetch the Midjourney image URL for this recipe
    let midjourneyImageUrl = "";
    try {
      // Get the most recent recipe image from the recipe_images table
      const recipeImage = await db.getOne(
        "SELECT image_path FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC LIMIT 1",
        [recipeId]
      );
      
      if (recipeImage && recipeImage.image_path) {
        // Construct the full URL path for the image
        midjourneyImageUrl = `/recipe_images/${recipeImage.image_path}`;
      }
    } catch (imageError) {
      console.error('Error fetching Midjourney image:', imageError);
      // Continue without image if there's an error
    }
    
    res.render('recipe-view', { 
      recipe,
      facebook,
      pinterestVariations,
      blog,
      midjourneyImageUrl, // Pass the image URL to the template
      pageTitle: recipe.recipe_idea,
      activePage: 'recipes',
      title: `RecipeGen AI - ${recipe.recipe_idea}`
    });
  } catch (error) {
    console.error('Error fetching recipe details:', error);
    res.status(500).render('error', {
      message: 'Failed to load recipe details',
      error: error,
      pageTitle: 'Error',
      activePage: '',
      title: 'RecipeGen AI - Error'
    });
  }
});

// Generator pages
app.get('/generate/pinterest',isAuthenticated, (req, res) => {
  res.render('generate-pinterest', {
  pageTitle: 'Generate Pinterest & Blog',
  activePage: 'generate-pinterest',
  title: 'RecipeGen AI - Generate Pinterest & Blog'
});
});

app.get('/generate/facebook',isAuthenticated, (req, res) => {
  res.render('generate-facebook', {
  pageTitle: 'Generate Facebook & Midjourney',
  activePage: 'generate-facebook',
  title: 'RecipeGen AI - Generate Facebook & Midjourney'
});
});

app.get('/generate/all',isAuthenticated, (req, res) => {
  res.render('generate-all', {
  pageTitle: 'Generate All Content',
  activePage: 'generate-all',
  title: 'RecipeGen AI - Generate All Content'
});
});

// WordPress settings page
app.get('/wordpress-settings', isAuthenticated, async (req, res) => {
  try {
    // Make sure to pass the user ID when getting settings
    const settings = await wordpressDb.getSettings(req.session.user.id);
    
    res.render('wordpress-settings', {
      pageTitle: 'WordPress Settings',
      activePage: 'wordpress-settings',
      title: 'RecipeGen AI - WordPress Settings',
      settings: settings || {},
      successMessage: req.session.successMessage || null,
      errorMessage: req.session.errorMessage || null
    });
    
    // Clear session messages
    delete req.session.successMessage;
    delete req.session.errorMessage;
  } catch (error) {
    console.error('Error loading WordPress settings:', error);
    res.render('wordpress-settings', {
      pageTitle: 'WordPress Settings',
      activePage: 'wordpress-settings',
      title: 'RecipeGen AI - WordPress Settings',
      settings: {},
      successMessage: null,
      errorMessage: 'Failed to load WordPress settings: ' + error.message
    });
  }
});

// Users management page (admin only)
app.get('/users', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    
    // Get all users in this organization
    const users = await userDb.getUsersByOrganization(organizationId);
    
    // Enrich with statistics for each user
    for (const user of users) {
      // Get recipe count
      user.stats = {
        recipeCount: await recipeDb.getRecipeCountByOwner(user.id),
        processedKeywords: await keywordsDb.getKeywordsCount('processed', null, user.id)
      };
      
      // Get last activity
      const lastActivity = await getOne(
        `SELECT created_at FROM activity_logs 
         WHERE user_id = ? 
         ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      
      if (lastActivity) {
        user.lastActive = lastActivity.created_at;
      }
    }
    
    res.render('users', {
      users: users,
      pageTitle: 'User Management',
      activePage: 'users',
      title: 'RecipeGen AI - User Management'
    });
  } catch (error) {
    console.error('Error loading users page:', error);
    res.render('error', {
      message: 'Failed to load users',
      error: error,
      pageTitle: 'Error',
      activePage: '',
      title: 'RecipeGen AI - Error'
    });
  }
});

// GET route for user edit page
app.get('/users/edit/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await userDb.getUserById(userId);
    
    if (!user) {
      req.session.errorMessage = 'User not found';
      return res.redirect('/users');
    }
    
    res.render('user-edit', {
      pageTitle: 'Edit User',
      activePage: 'users',
      title: 'RecipeGen AI - Edit User',
      user: user
    });
  } catch (error) {
    console.error('Error loading user edit page:', error);
    req.session.errorMessage = 'Failed to load user: ' + error.message;
    res.redirect('/users');
  }
});

// GET route for user delete (with confirmation)
app.get('/users/delete/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Don't allow deleting your own account
    if (userId === req.session.user.id) {
      req.session.errorMessage = 'You cannot delete your own account.';
      return res.redirect('/users');
    }
    
    const user = await userDb.getUserById(userId);
    
    if (!user) {
      req.session.errorMessage = 'User not found';
      return res.redirect('/users');
    }
    
    // Delete the user
    const deleteResult = await userDb.deleteUser(userId);
    
    if (deleteResult) {
      req.session.successMessage = 'User deleted successfully';
    } else {
      req.session.errorMessage = 'Failed to delete user';
    }
    
    res.redirect('/users');
  } catch (error) {
    console.error('Error deleting user:', error);
    req.session.errorMessage = 'Failed to delete user: ' + error.message;
    res.redirect('/users');
  }
});

// POST route for editing user
app.post('/users/edit/:id', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, email, role, password } = req.body;
    
    // Validate required fields
    if (!name || !email || !role) {
      req.session.errorMessage = 'Name, email, and role are required.';
      return res.redirect(`/users/edit/${userId}`);
    }
    
    // Update user
    const updateResult = await userDb.updateUser(userId, {
      name,
      email,
      role,
      password: password ? password : undefined // Only update password if provided
    });
    
    if (updateResult) {
      req.session.successMessage = 'User updated successfully';
      res.redirect('/users');
    } else {
      req.session.errorMessage = 'Failed to update user';
      res.redirect(`/users/edit/${userId}`);
    }
  } catch (error) {
    console.error('Error updating user:', error);
    req.session.errorMessage = 'Failed to update user: ' + error.message;
    res.redirect(`/users/edit/${userId}`);
  }
});

// WP Recipe Maker settings page
app.get('/wordpress-recipe-settings', isAuthenticated, async (req, res) => {
  try {
    // Load both WordPress and WPRM settings
    const wpSettings = await wordpressDb.getSettings(req.session.user.id);
    
    // Require recipe DB module
    const recipeDb = require('./wordpress-recipe-db');
    const wprmSettings = await recipeDb.getSettings();
    
    res.render('wordpress-recipe-settings', {
      pageTitle: 'WP Recipe Maker Settings',
      activePage: 'wordpress-recipe-settings',
      title: 'RecipeGen AI - WP Recipe Maker Settings',
      wpSettings: wpSettings || {},
      settings: wprmSettings || {},
      successMessage: req.session.successMessage || null,
      errorMessage: req.session.errorMessage || null
    });
    
    // Clear session messages
    delete req.session.successMessage;
    delete req.session.errorMessage;
  } catch (error) {
    console.error('Error loading WP Recipe Maker settings:', error);
    res.render('wordpress-recipe-settings', {
      pageTitle: 'WP Recipe Maker Settings',
      activePage: 'wordpress-recipe-settings',
      title: 'RecipeGen AI - WP Recipe Maker Settings',
      wpSettings: {},
      settings: {},
      successMessage: null,
      errorMessage: 'Failed to load WP Recipe Maker settings: ' + error.message
    });
  }
});

// Save WP Recipe Maker settings
app.post('/wordpress-recipe-settings', async (req, res) => {
  try {
    const { enabled, addToAllPosts, keywords } = req.body;
    
    // Require recipe DB module
    const recipeDb = require('./wordpress-recipe-db');
    
    // Save settings
    await recipeDb.saveSettings({
      enabled: enabled === 'on',
      addToAllPosts: addToAllPosts === 'on',
      keywords: keywords || ''
    });
    
    req.session.successMessage = 'WP Recipe Maker settings saved successfully!';
    res.redirect('/wordpress-recipe-settings');
  } catch (error) {
    console.error('Error saving WP Recipe Maker settings:', error);
    req.session.errorMessage = 'Failed to save WP Recipe Maker settings: ' + error.message;
    res.redirect('/wordpress-recipe-settings');
  }
});

app.post('/wordpress-settings', isAuthenticated, async (req, res) => {
  try {
    const { siteUrl, username, password, defaultStatus } = req.body;
    
    // Validate required fields
    if (!siteUrl || !username || !password) {
      req.session.errorMessage = 'Site URL, username, and password are required.';
      return res.redirect('/wordpress-settings');
    }
    
    // Save settings with userId from session
    await wordpressDb.saveSettings({
      userId: req.session.user.id,  // Make sure this is passed correctly
      siteUrl,
      username,
      password,
      defaultStatus: defaultStatus || 'draft'
    });
    
    req.session.successMessage = 'WordPress settings saved successfully!';
    res.redirect('/wordpress-settings');
  } catch (error) {
    console.error('Error saving WordPress settings:', error);
    req.session.errorMessage = 'Failed to save WordPress settings: ' + error.message;
    res.redirect('/wordpress-settings');
  }
});

// Add this route to get recipe template settings
app.get('/wordpress-recipe-templates',isAuthenticated, (req, res) => {
  try {
    // Load template settings
    const settings = recipeTemplateSettings.loadTemplateSettings();
    
    console.log('Loaded template settings:', settings);
    
    // Render the template settings page
    res.render('wordpress-recipe-templates', {
      title: 'Recipe Template Settings',
      settings: settings,
      user: req.user,
      messages: req.flash()
    });
  } catch (error) {
    console.error('Error loading template settings:', error);
    res.status(500).render('error', {
      message: 'Error loading template settings',
      error: error
    });
  }
});

// Add this route to save recipe template settings
app.post('/wordpress-recipe-templates',isAuthenticated, (req, res) => {
  try {
    console.log('Received template settings form data:', req.body);
    
    // Extract settings from request body
    const settings = {
      // Description templates
      defaultDescription: req.body.defaultDescription,
      cakeDescription: req.body.cakeDescription,
      soupDescription: req.body.soupDescription,
      saladDescription: req.body.saladDescription || '',
      chickenDescription: req.body.chickenDescription || '',
      
      // Notes templates settings
      enableStorageNote: req.body.enableStorageNote === 'on',
      storageNoteTemplate: req.body.storageNoteTemplate || '',
      storageDays: parseInt(req.body.storageDays) || 3,
      
      enableMakeAheadNote: req.body.enableMakeAheadNote === 'on',
      makeAheadTemplate: req.body.makeAheadTemplate || '',
      makeAheadHours: parseInt(req.body.makeAheadHours) || 24,
      dishType: req.body.dishType || 'dish',
      extraInstructions: req.body.extraInstructions || 'Cover and refrigerate until ready to serve.'
    };
    
    console.log('Processed settings to save:', settings);
    
    // Save settings
    const saved = recipeTemplateSettings.saveTemplateSettings(settings);
    
    if (saved) {
      // Set success message
      req.flash('success', 'Recipe template settings saved successfully.');
      console.log('Settings saved successfully');
    } else {
      // Set error message
      req.flash('error', 'Error saving recipe template settings.');
      console.log('Error saving settings');
    }
    
    // Redirect back to settings page
    res.redirect('/wordpress-recipe-templates');
  } catch (error) {
    console.error('Error saving template settings:', error);
    req.flash('error', 'Error saving recipe template settings: ' + error.message);
    res.redirect('/wordpress-recipe-templates');
  }
});

// User profile page
app.get('/profile', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const organizationId = req.session.user.organizationId;
    
    // Get user details
    const user = await userDb.getUserById(userId);

    if (user) {
  // Get user's content statistics if not already attached
  if (!user.stats) {
    user.stats = {
      recipeCount: await recipeDb.getRecipeCountByOwner(user.id),
      keywordCounts: {
        pending: await keywordsDb.getKeywordsCount('pending', null, user.id),
        processed: await keywordsDb.getKeywordsCount('processed', null, user.id),
        failed: await keywordsDb.getKeywordsCount('failed', null, user.id)
      },
      wpPostCount: 0
    };
    
    // Calculate totals
    user.stats.keywordCounts.total = user.stats.keywordCounts.pending + 
                                     user.stats.keywordCounts.processed + 
                                     user.stats.keywordCounts.failed;
    user.stats.totalContent = user.stats.recipeCount + user.stats.keywordCounts.processed;
    
    // Get WordPress post count if applicable
    try {
      user.stats.wpPostCount = await wordpressDb.getPublicationCount(user.id);
    } catch (error) {
      console.log('No WordPress publications found or error counting them:', error.message);
    }
  }
}
    
    // Get activity stats
    const stats = {
      recipeCount: await recipeDb.getRecipeCountByOwner(userId),
      keywordCounts: {
        pending: await keywordsDb.getKeywordsCount('pending', null, userId),
        processed: await keywordsDb.getKeywordsCount('processed', null, userId),
        failed: await keywordsDb.getKeywordsCount('failed', null, userId)
      },
      wpPostCount: 0
    };
    
    // Calculate totals
    stats.keywordCounts.total = stats.keywordCounts.pending + stats.keywordCounts.processed + stats.keywordCounts.failed;
    stats.totalContent = stats.recipeCount + stats.keywordCounts.processed;
    
    // Get WordPress post count if we have WordPress integration
    try {
      stats.wpPostCount = await wordpressDb.getPublicationCount(userId, null, req.session.currentWebsiteId);
    } catch (error) {
      console.log('No WordPress publications found or error counting them:', error.message);
    }
    
    // Get user activity
    const activity = await activityLogger.getRecentActivity(organizationId, 20, userId);
    
    res.render('profile', {
      user: user,
      stats: stats,
      activity: activity,
      pageTitle: 'User Profile',
      activePage: 'profile',
      title: 'RecipeGen AI - User Profile'
    });
  } catch (error) {
    console.error('Error loading profile page:', error);
    res.render('error', {
      message: 'Failed to load profile',
      error: error,
      pageTitle: 'Error',
      activePage: '',
      title: 'RecipeGen AI - Error'
    });
  }
});

// Add this middleware to update promptConfig when website changes
app.use((req, res, next) => {
  // Check if the website has changed
  if (req.session && 
      req.session.currentWebsiteId && 
      req.session.user && 
      req.session.user.organizationId) {
    
    // Only load settings if not already done for this request
    if (!req.promptConfigLoaded) {
      req.promptConfigLoaded = true;
      
      // Load website-specific settings
      try {
        const websiteSettings = promptSettingsDb.loadSettings(
          req.session.user.organizationId,
          req.session.currentWebsiteId
        );
        
        // Update the global promptConfig
        promptConfig = websiteSettings;
        
        // Update app.js configuration if needed
        const appModule = require('./app');
        appModule.updateConfig({
          model: promptConfig.model,
          temperature: promptConfig.temperature,
          apiKey: promptConfig.apiKey,
          language: promptConfig.language,
          pinCount: promptConfig.pinCount,
          prompts: promptConfig.prompts
        });
      } catch (error) {
        console.error('Error loading prompt settings for website switch:', error);
      }
    }
  }
  
  next();
});

// Find and replace your settings POST route in server.js with this enhanced version

app.post('/settings', isAuthenticated, (req, res) => {
  console.log('Received settings update');
  
  try {
    // Get the API key directly from the form
    const openaiApiKey = req.body.openaiApiKey;
    
    // Get organization ID and website ID from session
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    
    // Update prompt configuration
    const newSettings = {
      model: req.body.model || 'gpt-4-turbo-preview',
      temperature: parseFloat(req.body.temperature || '0.7'),
      apiKey: openaiApiKey,
      language: req.body.language || 'English',
      pinCount: parseInt(req.body.pinCount || '10'),
      
      // Add Discord settings
      discordChannelId: req.body.discordChannelId || '',
      discordUserToken: req.body.discordUserToken || '',
      discordWebhookUrl: req.body.discordWebhookUrl || '',
      enableDiscord: req.body.enableDiscord === 'on',
      
      prompts: {
        pinTitleSystem: req.body.pinTitleSystem || '',
        pinTitleUser: req.body.pinTitleUser || '',
        pinDescSystem: req.body.pinDescSystem || '',
        pinDescUser: req.body.pinDescUser || '',
        pinOverlaySystem: req.body.pinOverlaySystem || '',
        pinOverlayUser: req.body.pinOverlayUser || '',
        metaTitleSystem: req.body.metaTitleSystem || '',
        metaTitleUser: req.body.metaTitleUser || '',
        metaDescSystem: req.body.metaDescSystem || '',
        metaDescUser: req.body.metaDescUser || '',
        slugSystemPrompt: req.body.slugSystemPrompt || '',
        slugUserPrompt: req.body.slugUserPrompt || '',
        blogpostSystemPrompt: req.body.blogpostSystemPrompt || '',
        blogpostUserPrompt: req.body.blogpostUserPrompt || '',
        fbPrompt: req.body.fbPrompt || '',
        mjTemplate: req.body.mjTemplate || '',
        fbCaptionPrompt: req.body.fbCaptionPrompt || ''
      }
    };
    
    // Save settings to website-specific file
    promptSettingsDb.saveSettings(newSettings, organizationId, websiteId);
    
    // Also update global promptConfig for backward compatibility
    promptConfig = newSettings;
    
    console.log(`Saved prompt settings for organization ${organizationId} and website ${websiteId}`);
    console.log('Discord settings in new config:', {
      channelId: newSettings.discordChannelId ? 'SET' : 'NOT SET',
      token: newSettings.discordUserToken ? 'SET' : 'NOT SET',
      enabled: newSettings.enableDiscord
    });
    
    // Update the app.js module with the new config
    const appModule = require('./app');
    appModule.updateConfig({
      model: newSettings.model,
      temperature: newSettings.temperature,
      apiKey: openaiApiKey,
      language: newSettings.language,
      pinCount: newSettings.pinCount,
      // Pass Discord settings to app.js
      discordChannelId: newSettings.discordChannelId,
      discordUserToken: newSettings.discordUserToken,
      discordWebhookUrl: newSettings.discordWebhookUrl,
      enableDiscord: newSettings.enableDiscord,
      prompts: newSettings.prompts
    });
    
    console.log('Updated app.js module configuration with Discord settings');
    
    // Reset Midjourney client instance to pick up new settings
    try {
      const MidjourneyClient = require('./midjourney/midjourney-client');
      MidjourneyClient.resetInstance();
      console.log('✅ Reset Midjourney client to use new Discord settings');
    } catch (resetError) {
      console.warn('Could not reset Midjourney client:', resetError.message);
    }
    
    // Store in session
    req.session.promptConfig = newSettings;
    
    // Redirect with success message
    req.session.successMessage = 'Settings saved successfully!';
    res.redirect('/settings');
  } catch (error) {
    console.error('Error saving settings:', error);
    req.session.errorMessage = `Error saving settings: ${error.message}`;
    res.redirect('/settings');
  }
});

// ==========================================
// ALL API ENDPOINTS - MUST COME BEFORE ERROR HANDLERS
// ==========================================

// API endpoint to check API key status without revealing the key
app.get('/api/keys/status', async (req, res) => {
  try {
    const openaiKeyExists = !(await isApiKeyMissing('openai'));
    
    res.json({
      success: true,
      keys: {
        openai: openaiKeyExists
      }
    });
  } catch (error) {
    console.error('Error checking API key status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check API key status'
    });
  }
});

// Test OpenAI API connection
app.post('/api/test-connection', async (req, res) => {
  const { model, apiKey: providedApiKey } = req.body;
  
  // Use provided API key or get from database/env
  let apiKey = providedApiKey;
  if (!apiKey || apiKey.includes('•')) {
    // Try to get the key from the database first, then fall back to env if needed
    apiKey = await apiKeyManager.getApiKey('openai');
    
    // If still no key, use the one from promptConfig
    if (!apiKey) {
      apiKey = promptConfig.apiKey;
    }
  }
  
  if (!model) {
    return res.json({
      success: false,
      message: 'Model is required'
    });
  }
  
  if (!apiKey) {
    return res.json({
      success: false,
      message: 'No API key available. Please provide an OpenAI API key.'
    });
  }
  
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: model,
        messages: [
          { role: 'user', content: 'Hello, this is a test message. Please respond with "Connection successful".' }
        ],
        max_tokens: 20
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        }
      }
    );
    
    if (response.data && response.data.choices && response.data.choices.length > 0) {
      return res.json({
        success: true,
        message: 'Connection successful',
        model: model,
        response: response.data.choices[0].message.content.trim()
      });
    } else {
      return res.json({
        success: false,
        message: 'Invalid response from API'
      });
    }
  } catch (error) {
    console.error('API test error:', error.response?.data || error.message);
    return res.json({
      success: false,
      message: error.response?.data?.error?.message || error.message
    });
  }
});

// Add keywords API endpoint
// Add keywords API endpoint - FIXED VERSION
// Add keywords API endpoint - FIXED VERSION
// Add this debugging before we process the keywords
app.post('/api/keywords/add', isAuthenticated, activityMiddleware.logActivity('create', 'keyword'), async (req, res) => {
    try {
    console.log('Request body for keyword addition:', JSON.stringify(req.body, null, 2));
    
    let keywordsData = [];
    
    // Get user ID and organization ID from session
    const ownerId = req.session.user.id;
    const organizationId = req.session.user.organizationId;
    
    console.log(`User ID: ${ownerId}, Organization ID: ${organizationId}`);
    
    if (!ownerId || !organizationId) {
      const errorMsg = 'User authentication required - missing user ID or organization ID';
      console.error(errorMsg);
      return res.status(401).json({
        success: false,
        message: errorMsg
      });
    }
    
    // Check if data is coming from regular form submission
    if (req.body.keywords && typeof req.body.keywords === 'string') {
      // Split by lines and convert to array of objects
      keywordsData = req.body.keywords.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => ({ 
          keyword: line,
          category: req.body.defaultCategory || null,
          interests: req.body.defaultInterests || null,
          ownerId: ownerId,
          organizationId: organizationId
        }));
      console.log('Processed string keywords as:', keywordsData);
    } else if (req.body.keywords && Array.isArray(req.body.keywords)) {
      // Data is already in the correct format (from JavaScript handler)
      keywordsData = req.body.keywords.map(keyword => {
        if (typeof keyword === 'string') {
          return {
            keyword: keyword.trim(),
            category: req.body.defaultCategory || null,
            interests: req.body.defaultInterests || null,
            ownerId: ownerId,
            organizationId: organizationId
          };
        } else if (typeof keyword === 'object' && keyword.keyword) {
          return {
            keyword: keyword.keyword.trim(),
            category: keyword.category || req.body.defaultCategory || null,
            interests: keyword.interests || req.body.defaultInterests || null,
            ownerId: ownerId,
            organizationId: organizationId
          };
        }
        return null;
      }).filter(k => k !== null && k.keyword && k.keyword.trim().length > 0);
      
      console.log('Processed array keywords as:', keywordsData);
    }
    
    if (keywordsData.length === 0) {
      const errorMsg = 'No valid keywords provided after processing';
      console.error(errorMsg, { originalBody: req.body });
      return res.status(400).json({
        success: false,
        message: errorMsg
      });
    }
    
    // Add keywords to database
    console.log(`Attempting to add ${keywordsData.length} keywords to database`);
    const keywordIds = await keywordsDb.addKeywordsBatch(keywordsData);
    
    console.log(`Successfully added ${keywordIds.length} keywords to database`);
    
    // Return JSON response for API clients
    return res.json({
      success: true,
      message: `Added ${keywordIds.length} keywords successfully`,
      count: keywordIds.length
    });
    
  } catch (error) {
    console.error('Error adding keywords:', error);
    
    return res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Replace your existing /api/keywords/process-selected endpoint in server.js with this fixed version

app.post('/api/keywords/process-selected', isAuthenticated, activityMiddleware.logActivity('process', 'keyword'), async (req, res) => {
  try {
    const { keywordIds, contentOption } = req.body;
    
    if (!keywordIds || !Array.isArray(keywordIds) || keywordIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No keywords selected for processing'
      });
    }
    
    console.log(`🔄 Processing ${keywordIds.length} selected keywords with option: ${contentOption}`);
    
    // Get organization ID and user ID from session
    const organizationId = req.session.user.organizationId;
    const userId = req.session.user.id;
    const websiteId = req.session.currentWebsiteId; // IMPORTANT: Get current website ID
    
    console.log(`👤 User: ${userId}, 🏢 Org: ${organizationId}, 🌐 Website: ${websiteId}`);
    
    // Get full keyword data for the selected IDs
    const selectedKeywords = await keywordsDb.getKeywordsByIds(keywordIds, websiteId);
    
    if (selectedKeywords.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No keywords found with the provided IDs'
      });
    }
    
    console.log(`📋 Retrieved ${selectedKeywords.length} keywords for processing`);
    
    // Process each keyword
    const results = [];
    
    for (const keyword of selectedKeywords) {
      try {
        console.log(`🎯 Processing keyword: "${keyword.keyword}" (ID: ${keyword.id})`);
        
        // Verify keyword belongs to user's organization
        if (keyword.organization_id !== organizationId) {
          console.warn(`⚠️ Keyword ${keyword.id} belongs to different organization`);
          results.push({
            id: keyword.id,
            keyword: keyword.keyword,
            category: keyword.category,
            status: 'skipped',
            message: 'Keyword does not belong to your organization',
          });
          continue;
        }
        
        // For employees, verify they own the keyword
        if (req.session.user.role === 'employee' && keyword.owner_id !== userId) {
          console.warn(`⚠️ Employee ${userId} doesn't own keyword ${keyword.id}`);
          results.push({
            id: keyword.id,
            keyword: keyword.keyword,
            category: keyword.category,
            status: 'skipped',
            message: 'You do not have permission to process this keyword',
          });
          continue;
        }
        
        // Skip keywords that are already processed
        if (keyword.status === 'processed') {
          console.log(`✅ Keyword ${keyword.id} already processed`);
          results.push({
            id: keyword.id,
            keyword: keyword.keyword,
            category: keyword.category,
            status: 'skipped',
            message: 'Keyword already processed',
            recipeId: keyword.recipe_id
          });
          continue;
        }
        
        // CRITICAL FIX: Set global website context before database operations
        global.currentWebsiteId = websiteId;
        
        // Create recipe record
        console.log(`📝 Creating recipe for keyword: "${keyword.keyword}"`);
        const recipeId = await recipeDb.createRecipe({
          recipeIdea: keyword.keyword.trim(),
          category: keyword.category,
          interests: keyword.interests,
          language: promptConfig.language || 'English',
          ownerId: userId,
          organizationId: organizationId,
          websiteId: websiteId // Explicitly pass websiteId
        });
        
        console.log(`✅ Created recipe with ID: ${recipeId}`);
        
        // Update app.js config with current promptConfig
        const appModule = require('./app');
        appModule.updateConfig({
          model: promptConfig.model,
          apiKey: promptConfig.apiKey,
          language: promptConfig.language,
          temperature: promptConfig.temperature,
          pinCount: promptConfig.pinCount,
          prompts: promptConfig.prompts
        });
        
        let contentGenerated = false;
        
        // Generate content based on selected option
        if (contentOption === 'facebook' || contentOption === 'all') {
          try {
            console.log(`📱 Generating Facebook content for: "${keyword.keyword}"`);
            const facebookContent = await appModule.generateFacebookContent(keyword.keyword);
            
            if (facebookContent) {
              // Save Facebook content with explicit websiteId
              await facebookDb.saveFacebookContent(recipeId, {
                ...facebookContent,
                websiteId: websiteId
              });
              
              console.log(`✅ Saved Facebook content for recipe: ${recipeId}`);
              contentGenerated = true;
              
              // Generate Midjourney image for the recipe (if enabled)
              try {
                console.log(`🎨 Attempting Midjourney image generation for recipe ${recipeId}...`);
                
                // Get current Discord settings for this user session
                const discordSettings = getCurrentDiscordSettings(req);
                
                if (discordSettings && discordSettings.enableDiscord) {
                  console.log('🔗 Discord settings available, proceeding with image generation');
                  
                  // Pass Discord settings to the image generator
                  const imageResult = await imageGenerator.generateImageForRecipeWithSettings(recipeId, discordSettings);
                  
                  if (imageResult.success) {
                    console.log(`✅ Successfully generated Midjourney image for recipe ${recipeId}: ${imageResult.imagePath}`);
                    // Add delay between generations to prevent Discord issues
                    await new Promise(resolve => setTimeout(resolve, 8000)); // 8 second delay
                  } else {
                    console.warn(`⚠️ Failed to generate Midjourney image for recipe ${recipeId}: ${imageResult.error}`);
                  }
                } else {
                  console.log('ℹ️ Discord settings not available or disabled, skipping image generation');
                }
              } catch (imageError) {
                console.error(`❌ Error generating Midjourney image for recipe ${recipeId}:`, imageError);
                // Continue processing even if image generation fails
              }
            }
          } catch (fbError) {
            console.error(`❌ Facebook content generation failed for "${keyword.keyword}":`, fbError);
            throw fbError; // Re-throw to mark keyword as failed
          }
        }
        
        if (contentOption === 'pinterest' || contentOption === 'all') {
          try {
            console.log(`📌 Generating Pinterest content for: "${keyword.keyword}"`);
            const pinterestContent = await appModule.generatePinterestContent(
              keyword.keyword,
              keyword.category,
              keyword.interests
            );
            
            // Save Pinterest variations
            if (pinterestContent && pinterestContent.length > 0) {
              for (let i = 0; i < pinterestContent.length; i++) {
                await pinterestDb.savePinterestVariation(
                  recipeId,
                  {
                    ...pinterestContent[i],
                    websiteId: websiteId
                  },
                  i + 1
                );
              }
              
              console.log(`✅ Saved ${pinterestContent.length} Pinterest variations for recipe: ${recipeId}`);
              contentGenerated = true;
              
              // Generate blog post from first Pinterest variation
              if (pinterestContent.length > 0) {
                console.log(`📝 Generating blog content for: "${keyword.keyword}"`);
                const blogContent = await appModule.generateBlogPost(
                  keyword.keyword,
                  keyword.category,
                  keyword.interests,
                  pinterestContent[0].metaTitle,
                  pinterestContent[0].metaDesc
                );
                
                if (blogContent) {
                  await blogDb.saveBlogContent(
                    recipeId,
                    blogContent,
                    null,
                    websiteId // Explicitly pass websiteId
                  );
                  console.log(`✅ Saved blog content for recipe: ${recipeId}`);
                }
              }
            }
          } catch (pinterestError) {
            console.error(`❌ Pinterest content generation failed for "${keyword.keyword}":`, pinterestError);
            throw pinterestError; // Re-throw to mark keyword as failed
          }
        }
        
        // CRITICAL FIX: Update keyword status with explicit websiteId
        if (contentGenerated) {
          console.log(`🔄 Updating keyword ${keyword.id} status to 'processed' with recipe ID: ${recipeId}`);
          
          // Use explicit websiteId in the status update
          await keywordsDb.updateKeywordStatus(keyword.id, 'processed', recipeId, websiteId);
          
          // VERIFICATION: Double-check the update worked
          const updatedKeyword = await keywordsDb.getKeywordById(keyword.id, websiteId);
          if (updatedKeyword && updatedKeyword.status === 'processed') {
            console.log(`✅ Successfully updated keyword ${keyword.id} status to 'processed'`);
          } else {
            console.error(`❌ Failed to update keyword ${keyword.id} status - current status: ${updatedKeyword?.status}`);
          }
          
          results.push({
            id: keyword.id,
            keyword: keyword.keyword,
            category: keyword.category,
            status: 'processed',
            recipeId: recipeId,
            contentOption: contentOption
          });
        } else {
          throw new Error('No content was generated');
        }
        
      } catch (error) {
        console.error(`❌ Error processing keyword "${keyword.keyword}":`, error);
        
        // CRITICAL FIX: Update keyword status to failed with explicit websiteId
        try {
          await keywordsDb.updateKeywordStatus(keyword.id, 'failed', null, websiteId);
          console.log(`⚠️ Updated keyword ${keyword.id} status to 'failed'`);
        } catch (updateError) {
          console.error(`❌ Failed to update keyword ${keyword.id} status to failed:`, updateError);
        }
        
        results.push({
          id: keyword.id,
          keyword: keyword.keyword,
          category: keyword.category,
          status: 'failed',
          message: error.message || 'Failed to process'
        });
      }
    }
    
    console.log(`🏁 Processing complete. Results: ${JSON.stringify(results.map(r => ({ id: r.id, status: r.status })))}`);
    
    // Return results
    res.json({
      success: true,
      results: results,
      message: `Processed ${results.filter(r => r.status === 'processed').length} keywords successfully`
    });
    
  } catch (error) {
    console.error('❌ Error processing selected keywords:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Add this temporary debugging route to server.js (after your other routes)
app.get('/debug-midjourney', isAuthenticated, async (req, res) => {
  try {
    const MidjourneyClient = require('./midjourney/midjourney-client');
    const client = MidjourneyClient.getInstance();
    
    console.log('🧪 Running Midjourney debug test...');
    
    // Test initialization
    await client.initialize();
    
    // Test message retrieval
    const testResult = await client.testDiscordMessages();
    
    res.json({
      success: true,
      initialization: {
        userId: client.userId,
        guildId: client.guildId,
        channelId: client.channelId
      },
      messageTest: testResult
    });
  } catch (error) {
    console.error('Debug test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete keywords API endpoint
app.post('/api/keywords/delete', isAuthenticated, activityMiddleware.logActivity('delete', 'keyword'), async (req, res) => {
  try {
    const { keywordIds } = req.body;
    
    if (!keywordIds || !Array.isArray(keywordIds) || keywordIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No keywords selected for deletion'
      });
    }
    
    console.log(`Deleting ${keywordIds.length} keywords`);
    
    // Delete the keywords
    await keywordsDb.deleteKeywords(keywordIds);
    
    res.json({
      success: true,
      message: `Deleted ${keywordIds.length} keywords successfully`,
      count: keywordIds.length
    });
    
  } catch (error) {
    console.error('Error deleting keywords:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Process keywords API endpoint
app.post('/api/keywords/process',isAuthenticated, async (req, res) => {
  try {
    const { keywords, autoGenerate } = req.body;
    
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid keywords provided'
      });
    }
    
    console.log(`Processing ${keywords.length} keywords, autoGenerate: ${autoGenerate}`);
    
    // Process each keyword
    const results = [];
    
    for (const keyword of keywords) {
      try {
        // Validate the keyword
        if (!keyword.recipeIdea || typeof keyword.recipeIdea !== 'string' || keyword.recipeIdea.trim().length === 0) {
          results.push({
            recipeIdea: keyword.recipeIdea || 'Empty',
            category: keyword.category,
            success: false,
            message: 'Invalid recipe idea'
          });
          continue;
        }
        
        // Create recipe record
        // Create a new recipe
const recipeId = await recipeDb.createRecipe({
  recipeIdea: keyword.recipeIdea,
  category: keyword.category,
  interests: keyword.interests,
  language: promptConfig.language,
  ownerId: req.session.user.id,
  organizationId: req.session.user.organizationId
});
        
        // If auto-generate is enabled, generate content for this recipe
        if (autoGenerate) {
          try {
            // Update app.js config with current promptConfig
            const appModule = require('./app');
            appModule.updateConfig({
              model: promptConfig.model,
              apiKey: promptConfig.apiKey,
              language: promptConfig.language,
              temperature: promptConfig.temperature,
              pinCount: promptConfig.pinCount,
              prompts: promptConfig.prompts
            });
            
            // Generate Facebook content (creates the basic recipe)
            const facebookContent = await appModule.generateFacebookContent(keyword.recipeIdea);
            
            if (facebookContent) {
              // Save Facebook content
              await facebookDb.saveFacebookContent(recipeId, facebookContent);
              
              // Optionally generate Pinterest content
              try {
                const pinterestContent = await appModule.generatePinterestContent(
                  keyword.recipeIdea,
                  keyword.category,
                  keyword.interests
                );
                
                // Save Pinterest variations
                if (pinterestContent && pinterestContent.length > 0) {
                  for (let i = 0; i < pinterestContent.length; i++) {
                    await pinterestDb.savePinterestVariation(
                      recipeId,
                      pinterestContent[i],
                      i + 1
                    );
                  }
                }
              } catch (pinterestError) {
                console.warn(`Pinterest generation error for "${keyword.recipeIdea}":`, pinterestError);
              }
            }
          } catch (generateError) {
            console.warn(`Content generation error for "${keyword.recipeIdea}":`, generateError);
            // We continue despite generation errors since the recipe was created
          }
        }
        
        // Add to results
        results.push({
          recipeIdea: keyword.recipeIdea,
          category: keyword.category,
          success: true,
          recipeId: recipeId
        });
        
      } catch (keywordError) {
        console.error(`Error processing keyword "${keyword.recipeIdea}":`, keywordError);
        
        results.push({
          recipeIdea: keyword.recipeIdea,
          category: keyword.category,
          success: false,
          message: keywordError.message || 'Failed to process'
        });
      }
    }
    
    // Return results
    res.json({
      success: true,
      results: results
    });
    
  } catch (error) {
    console.error('Error processing keywords:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// PinClicks Analysis API Endpoint
app.post('/api/analyze-pinclicks',isAuthenticated, async (req, res) => {
  try {
    const { csv, keyword } = req.body;
    
    if (!csv || !keyword) {
      return res.status(400).json({
        success: false,
        message: 'CSV data and keyword are required'
      });
    }
    
    console.log(`Analyzing PinClicks data for keyword: ${keyword}`);
    
    // Parse the CSV
    const csvLines = csv.split('\n');
    if (csvLines.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'CSV is empty or invalid'
      });
    }
    
    const headers = csvLines[0].split(',');
    
    // Extract keywords and their occurrence data
    const keywordData = [];
    for (let i = 1; i < csvLines.length; i++) {
      const line = csvLines[i].trim();
      if (!line) continue;
      
      const columns = line.split(',');
      if (columns.length >= 2) {
        const keywordCol = columns[0].trim();
        const occurrences = parseInt(columns[1]) || 0;
        
        if (keywordCol && occurrences > 0) {
          keywordData.push({
            keyword: keywordCol,
            occurrences
          });
        }
      }
    }
    
    // Simple algorithm to extract interests
    const relevantKeywords = keywordData
      .filter(item => item.occurrences >= 3)
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10) // Take top 10
      .map(item => item.keyword.toLowerCase())
      .filter(keyword => keyword.length > 2); // Remove very short keywords
    
    const interests = relevantKeywords.join(', ');
    
    return res.json({
      success: true,
      interests: interests
    });
  } catch (error) {
    console.error('Error analyzing PinClicks data:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Fixed /api/generate/facebook endpoint
app.post('/api/generate/facebook', isAuthenticated, activityMiddleware.logActivity('create', 'recipe'), async (req, res) => {
  try {
    let { recipeIdea } = req.body;
    
    // Make sure recipeIdea is a clean string
    recipeIdea = (recipeIdea || '').trim();
    
    if (!recipeIdea) {
      return res.status(400).json({
        success: false,
        message: 'Recipe idea is required'
      });
    }
    
    console.log('Generating Facebook content for recipe idea:', recipeIdea);
    
    // Update app.js config with current promptConfig
    const appModule = require('./app');
    appModule.updateConfig({
      model: promptConfig.model,
      apiKey: promptConfig.apiKey,
      language: promptConfig.language,
      temperature: promptConfig.temperature,
      pinCount: promptConfig.pinCount,
      prompts: promptConfig.prompts || {
        fbPrompt: promptConfig.fbPrompt,
        mjTemplate: promptConfig.mjTemplate,
        fbCaptionPrompt: promptConfig.fbCaptionPrompt
      }
    });
    
    // Generate the content
    const facebookContent = await generateFacebookContent(recipeIdea);
    
    // Initialize category and interests from request body
    const category = req.body.category || null;
    const interests = req.body.interests || null;
    
    // Create recipe record in database
    // Create recipe record in database
const recipeId = await recipeDb.createRecipe({
  recipeIdea,
  category,
  interests, 
  language: promptConfig.language,
  ownerId: req.session.user.id,
  organizationId: req.session.user.organizationId
});
    
    console.log('Created recipe record with ID:', recipeId);
    
    // Make sure facebookContent exists and has expected structure
    if (!facebookContent) {
      throw new Error('Failed to generate Facebook content');
    }
    
    // Save Facebook content in database
    const facebookId = await facebookDb.saveFacebookContent(
      recipeId,
      facebookContent
    );
    
    console.log('Saved Facebook content with ID:', facebookId);
    
    // Ensure we're returning a properly structured response
    // with all necessary properties to prevent undefined errors
    res.json({
      success: true,
      data: {
        recipeId: recipeId,
        facebook: {
          id: facebookId,
          recipe: facebookContent.recipe || '',
          title: facebookContent.title || '',
          fbCaption: facebookContent.fbCaption || '',
          mjPrompt: facebookContent.mjPrompt || '',
          ingredients: facebookContent.allIngredients || ''
        }
      }
    });
  } catch (error) {
    console.error('Error generating Facebook content:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Generate Pinterest content
// Fixed /api/generate/pinterest endpoint
app.post('/api/generate/pinterest', isAuthenticated, activityMiddleware.logActivity('create', 'recipe'), async (req, res) => {
try {
    const { recipeIdea, category, interests, generateBlog = false } = req.body;
    
    if (!recipeIdea) {
      return res.status(400).json({
        success: false,
        message: 'Recipe idea is required'
      });
    }
    
    // Update app.js config with current promptConfig
    const appModule = require('./app');
    appModule.updateConfig({
      model: promptConfig.model,
      apiKey: promptConfig.apiKey,
      language: promptConfig.language,
      temperature: promptConfig.temperature,
      pinCount: promptConfig.pinCount,
      prompts: promptConfig.prompts
    });
    
    // First check if we need to create a new recipe or there's an existing one
    let recipeId;
    const existingRecipes = await recipeDb.searchRecipes(recipeIdea, 1, 0);
    if (existingRecipes && existingRecipes.length > 0 && 
        existingRecipes[0].recipe_idea.toLowerCase() === recipeIdea.toLowerCase()) {
      // Use existing recipe
      recipeId = existingRecipes[0].id;
      console.log('Using existing recipe with ID:', recipeId);
    } else {
      // Create a new recipe
      recipeId = await recipeDb.createRecipe({
        recipeIdea,
        category,
        interests,
        language: promptConfig.language,
        ownerId: req.session.user.id,
        organizationId: req.session.user.organizationId
      });
      console.log('Created new recipe with ID:', recipeId);
    }
    
    // IMPORTANT: First generate Facebook content to establish recipe details
    console.log('First generating Facebook content to establish recipe details...');
    const facebookContent = await generateFacebookContent(recipeIdea);
    
    // Save Facebook content if it doesn't exist yet
    const existingFacebook = await facebookDb.getFacebookContentByRecipeId(recipeId);
    if (!existingFacebook) {
      await facebookDb.saveFacebookContent(recipeId, facebookContent);
      console.log('Saved Facebook content for recipe ID:', recipeId);
    }
    
    // Now generate Pinterest content
    const pinterestContent = await generatePinterestContent(recipeIdea, category, interests);
    
    if (!pinterestContent || pinterestContent.length === 0) {
      throw new Error('Failed to generate Pinterest content');
    }
    
    // Save Pinterest variations to database
    const variationIds = [];
    for (let i = 0; i < pinterestContent.length; i++) {
      const variationId = await pinterestDb.savePinterestVariation(
        recipeId,
        pinterestContent[i],
        i + 1
      );
      variationIds.push(variationId);
      console.log(`Saved Pinterest variation ${i+1} with ID:`, variationId);
    }
    
    // If generateBlog flag is true, generate the blog post (for backward compatibility)
    let blogContent = null;
    let blogId = null;
    
    if (generateBlog) {
      const variation = pinterestContent[0];
      blogContent = await generateBlogPost(
        recipeIdea,
        category, 
        interests,
        variation.metaTitle,
        variation.metaDesc
      );
      
      // Save blog post to database
      blogId = await blogDb.saveBlogContent(
        recipeId,
        blogContent,
        variationIds[0]
      );
      console.log('Saved blog content with ID:', blogId);
    }
    
    // Files are no longer needed with our database approach, but we'll maintain
    // compatibility with old code that expects file URLs
    const files = {
      pinterest: `/recipe/${recipeId}`,
      results: `/recipe/${recipeId}`
    };
    
    if (blogContent) {
      files.blog = `/recipe/${recipeId}`;
    }
    
    res.json({
      success: true,
      recipeId: recipeId,
      data: {
        recipeId: recipeId,
        pinterest: pinterestContent,
        blog: blogContent
      },
      files: files
    });
  } catch (error) {
    console.error('Error generating Pinterest content:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Fixed /api/generate/all endpoint
app.post('/api/generate/all', isAuthenticated, activityMiddleware.logActivity('create', 'recipe'), async (req, res) => {
    try {
    const { recipeIdea } = req.body;
    
    if (!recipeIdea) {
      return res.status(400).json({
        success: false,
        message: 'Recipe idea is required'
      });
    }
    
    // Update app.js config with current promptConfig
    const appModule = require('./app');
    appModule.updateConfig({
      model: promptConfig.model,
      apiKey: promptConfig.apiKey,
      language: promptConfig.language,
      temperature: promptConfig.temperature,
      pinCount: promptConfig.pinCount,
      prompts: promptConfig.prompts
    });
    
    // Initialize category and interests from request body
    const category = req.body.category || null;
    const interests = req.body.interests || null;
    
    // Create recipe record in database
    const recipeId = await recipeDb.createRecipe({
      recipeIdea,
      category,
      interests,
      language: promptConfig.language,
      ownerId: req.session.user.id,
      organizationId: req.session.user.organizationId
    });
    
    console.log('Created recipe record with ID:', recipeId);
    
    // IMPORTANT CHANGE: Generate Facebook content FIRST
    // This ensures the recipe details are stored in sharedRecipeState
    // before generating the blog post
    console.log('Generating Facebook content first to establish recipe details...');
    const facebookContent = await generateFacebookContent(recipeIdea);
    
    if (!facebookContent) {
      throw new Error('Failed to generate Facebook content');
    }
    
    // Save Facebook content
    const facebookId = await facebookDb.saveFacebookContent(
      recipeId,
      facebookContent
    );
    
    console.log('Saved Facebook content with ID:', facebookId);
    
    // Now generate Pinterest content
    const pinterestContent = await generatePinterestContent(recipeIdea, category, interests);
    
    if (!pinterestContent || pinterestContent.length === 0) {
      throw new Error('Failed to generate Pinterest content');
    }
    
    // Save Pinterest variations
    const variationIds = [];
    for (let i = 0; i < pinterestContent.length; i++) {
      const variationId = await pinterestDb.savePinterestVariation(
        recipeId,
        pinterestContent[i],
        i + 1
      );
      variationIds.push(variationId);
      console.log(`Saved Pinterest variation ${i+1} with ID:`, variationId);
    }
    
    // Generate blog content from first Pinterest variation
    // By generating Facebook first, the blog will use those recipe details
    let blogContent = null;
    let blogId = null;
    
    if (pinterestContent.length > 0) {
      const variation = pinterestContent[0];
      blogContent = await generateBlogPost(
        recipeIdea,
        category,
        interests,
        variation.metaTitle,
        variation.metaDesc
      );
      
      if (!blogContent) {
        console.warn('Blog content generation returned null or empty');
        blogContent = ''; // Provide default empty string
      }
      
      // Save blog content
      blogId = await blogDb.saveBlogContent(
        recipeId,
        blogContent,
        variationIds[0]
      );
      
      console.log('Saved blog content with ID:', blogId);
    }
    
    // Files are no longer needed with our database approach, but we'll maintain
    // compatibility with old code that expects file URLs
    const files = {
      results: `/recipe/${recipeId}`,
      pinterest: `/recipe/${recipeId}`,
      facebook: `/recipe/${recipeId}`
    };
    
    if (blogContent) {
      files.blog = `/recipe/${recipeId}`;
    }
    
    res.json({
      success: true,
      recipeId: recipeId,
      data: {
        recipeId: recipeId,
        pinterest: pinterestContent,
        blog: blogContent,
        facebook: {
          recipe: facebookContent.recipe || '',
          title: facebookContent.title || '',
          fbCaption: facebookContent.fbCaption || '',
          mjPrompt: facebookContent.mjPrompt || ''
        }
      },
      files: files
    });
  } catch (error) {
    console.error('Error generating all content:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Fixed blog generation from variation endpoint
// Fixed blog-from-variation endpoint that specifically handles index vs ID issue
app.post('/api/generate/blog-from-variation',isAuthenticated, async (req, res) => {
  try {
    // Get parameters from request
    const { recipeId, variationId, variationIndex } = req.body;
    
    console.log('Blog generation request params:', { 
      recipeId, 
      variationId, 
      variationIndex
    });
    
    // Require recipeId
    if (!recipeId) {
      return res.status(400).json({
        success: false,
        message: 'Recipe ID is required'
      });
    }
    
    // Get recipe details
    const recipe = await recipeDb.getRecipeById(recipeId);
    if (!recipe) {
      console.error('Recipe not found with ID:', recipeId);
      return res.status(404).json({
        success: false,
        message: 'Recipe not found'
      });
    }
    
    // Get all Pinterest variations for this recipe
    const allVariations = await pinterestDb.getVariationsByRecipeId(recipeId);
    console.log(`Found ${allVariations.length} variations for recipe ID: ${recipeId}`);
    
    if (!allVariations || allVariations.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No Pinterest variations found for this recipe'
      });
    }
    
    // Find the variation to use for blog generation
    let variation = null;
    
    // First check if we have a valid variationIndex
    if (variationIndex !== undefined && variationIndex !== null) {
      const index = parseInt(variationIndex);
      console.log(`Attempting to find variation by index: ${index}`);
      
      if (!isNaN(index) && index >= 0 && index < allVariations.length) {
        variation = allVariations[index];
        console.log(`Found variation by index ${index}, ID: ${variation.id}`);
      }
    }
    
    // If no variation found by index, try by ID
    if (!variation && variationId) {
      console.log(`Attempting to find variation by ID: ${variationId}`);
      
      // Try direct lookup
      variation = await pinterestDb.getVariationById(variationId);
      
      // If variationId looks like a number (not a UUID), it might be an index
      if (!variation && /^\d+$/.test(variationId)) {
        const index = parseInt(variationId);
        console.log(`variationId appears to be a numeric index: ${index}, trying array lookup`);
        
        if (!isNaN(index) && index >= 0 && index < allVariations.length) {
          variation = allVariations[index];
          console.log(`Found variation by numeric ID (treated as index): ${index}`);
        }
      }
    }
    
    // If still no variation, use the first one
    if (!variation && allVariations.length > 0) {
      variation = allVariations[0];
      console.log(`No specific variation found, using first variation: ${variation.id}`);
    }
    
    // If we still have no variation, something is wrong
    if (!variation) {
      console.error('Could not find any usable Pinterest variation');
      return res.status(404).json({
        success: false,
        message: 'Pinterest variation not found'
      });
    }
    
    // Log the variation we're using
    console.log('Using variation:', {
      id: variation.id,
      variation_number: variation.variation_number,
      pin_title: variation.pin_title
    });
    
    // Update app.js config with current promptConfig
    const appModule = require('./app');
    appModule.updateConfig({
      model: promptConfig.model,
      apiKey: promptConfig.apiKey,
      language: promptConfig.language || recipe.language || 'English',
      temperature: promptConfig.temperature,
      pinCount: promptConfig.pinCount,
      prompts: promptConfig.prompts
    });
    
    // Generate blog content
    console.log(`Generating blog content for: ${recipe.recipe_idea}`);
    console.log(`Using meta title: ${variation.meta_title}`);
    console.log(`Using meta description: ${variation.meta_description}`);
    
    const blogContent = await generateBlogPost(
      recipe.recipe_idea,
      recipe.category,
      recipe.interests,
      variation.meta_title,
      variation.meta_description
    );
    
    // Handle case when blog content generation fails
    if (!blogContent) {
      console.error('Blog content generation returned null or undefined');
      return res.status(500).json({
        success: false,
        message: 'Failed to generate blog content'
      });
    }
    
    // Save or update blog content
    const blogId = await blogDb.updateBlogContent(
      recipeId,
      blogContent,
      variation.id
    );
    
    console.log('Saved/updated blog content with ID:', blogId);
    
    // Return the blog content
    res.json({
      success: true,
      blogId,
      blogContent
    });
    
  } catch (error) {
    console.error('Error generating blog from variation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate blog from variation: ' + (error.message || 'Unknown error')
    });
  }
});

// Adding backward compatibility for filesystem-based storage approach
// This helps when transitioning from the old system to the new database system
app.post('/api/generate/blog-from-variation-fs', isAuthenticated, async (req, res) => {
  try {
    const { recipeIdea, category, interests, variation } = req.body;
    
    if (!variation || !variation.metaTitle || !variation.metaDesc) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Pinterest variation provided'
      });
    }
    
    // Update app.js config with current promptConfig
    const appModule = require('./app');
    appModule.updateConfig({
      model: promptConfig.model,
      apiKey: promptConfig.apiKey,
      language: promptConfig.language,
      temperature: promptConfig.temperature,
      pinCount: promptConfig.pinCount,
      prompts: promptConfig.prompts
    });
    
    console.log(`Generating blog post for Pinterest variation: "${variation.pinTitle}"`);
    console.log(`Using meta title: "${variation.metaTitle}"`);
    console.log(`Using meta description: "${variation.metaDesc}"`);
    
    // Generate blog content using the selected variation's meta title and description
    const blogContent = await generateBlogPost(
      recipeIdea,
      category,
      interests,
      variation.metaTitle,
      variation.metaDesc
    );
    
    // Create output directory for filesystem storage (backward compatibility)
    const outputDir = path.join(__dirname, 'output', recipeIdea.replace(/[^a-z0-9]/gi, '_').toLowerCase());
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Save the blog content to filesystem
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blogOutputFile = path.join(outputDir, `${timestamp}-blog-post-variation-${variation.metaSlug}.html`);
    fs.writeFileSync(blogOutputFile, blogContent);
    
    // Return the blog content and file path
    res.json({
      success: true,
      blogContent: blogContent,
      blogFile: `/output/${recipeIdea.replace(/[^a-z0-9]/gi, '_').toLowerCase()}/${path.basename(blogOutputFile)}`
    });
    
  } catch (error) {
    console.error('Error generating blog from variation (filesystem):', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Test WordPress connection
app.post('/api/wordpress/test-connection',isAuthenticated, async (req, res) => {
  try {
    const { siteUrl, username, password } = req.body;
    
    // Validate required fields
    if (!siteUrl || !username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Site URL, username, and password are required.'
      });
    }
    
    // Initialize WordPress client
    const wp = new WordPressClient({
      siteUrl,
      username,
      password
    });
    
    // Test connection
    const result = await wp.validateConnection();
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('WordPress connection test error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to connect to WordPress'
    });
  }
});

// Test WP Recipe Maker connection
app.post('/api/wordpress/test-wprm-connection',isAuthenticated, async (req, res) => {
  try {
    // Get WordPress settings
    const wpSettings = await wordpressDb.getSettings(req.session.user.id);
    
    if (!wpSettings || !wpSettings.site_url || !wpSettings.username || !wpSettings.password) {
      return res.status(400).json({
        success: false,
        message: 'WordPress settings are required. Please configure WordPress first.'
      });
    }
    
    // Configure WordPress API
    const wpConfig = {
      apiUrl: `${wpSettings.site_url}/wp-json/wp/v2`,
      username: wpSettings.username,
      password: wpSettings.password
    };
    
    // Require recipe helper module
    const recipeHelper = require('./recipe-helper');
    
    // Test connection
    const result = await recipeHelper.testWPRMApiConnection(wpConfig);
    
    res.json({
      success: true,
      message: 'WP Recipe Maker connection test successful'
    });
  } catch (error) {
    console.error('WP Recipe Maker connection test error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to connect to WP Recipe Maker'
    });
  }
});

// Publish to WordPress
app.post('/api/wordpress/publish',isAuthenticated, async (req, res) => {
  try {
    const { recipeId, status } = req.body;
    
    if (!recipeId) {
      return res.status(400).json({
        success: false,
        message: 'Recipe ID is required'
      });
    }
    
    // Get WordPress settings
    const settings = await wordpressDb.getSettings(req.session.user.id);
    if (!settings || !settings.site_url || !settings.username || !settings.password) {
      return res.status(400).json({
        success: false,
        message: 'WordPress settings are not configured. Please set up your WordPress connection first.'
      });
    }
    
    // Get recipe details
    const recipe = await recipeDb.getRecipeById(recipeId);
    if (!recipe) {
      return res.status(404).json({
        success: false,
        message: 'Recipe not found'
      });
    }
    
    // Get blog content
    const blog = await blogDb.getBlogContentByRecipeId(recipeId);
    if (!blog || !blog.html_content) {
      return res.status(404).json({
        success: false,
        message: 'No blog content found for this recipe'
      });
    }
    
    // Get Pinterest variation for meta info
    let metaTitle = recipe.recipe_idea;
    let metaSlug = '';
    let categories = [];
    
    if (blog.pinterest_variation_id) {
      const variation = await pinterestDb.getVariationById(blog.pinterest_variation_id);
      if (variation) {
        metaTitle = variation.meta_title || metaTitle;
        metaSlug = variation.meta_slug || '';
      }
    } else {
      // Try to get the first variation
      const variations = await pinterestDb.getVariationsByRecipeId(recipeId);
      if (variations && variations.length > 0) {
        metaTitle = variations[0].meta_title || metaTitle;
        metaSlug = variations[0].meta_slug || '';
      }
    }
    
    // Initialize WordPress client
    const wp = new WordPressClient({
      siteUrl: settings.site_url,
      username: settings.username,
      password: settings.password
    });
    
    // Create the post
    const postData = {
      title: metaTitle,
      content: blog.html_content,
      status: status || settings.default_status || 'draft',
      categories: categories,
      slug: metaSlug
    };
    
    const result = await wp.createPost(postData);
    
    // Save publication record
    await wordpressDb.savePublication({
      recipeId: recipeId,
      wpPostId: result.id,
      wpPostUrl: result.link,
      wpStatus: result.status,
      websiteId: req.session.currentWebsiteId
    });
    
    res.json({
      success: true,
      post: {
        id: result.id,
        url: result.link,
        status: result.status,
        title: result.title.rendered
      }
    });
  } catch (error) {
    console.error('Error publishing to WordPress:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to publish to WordPress'
    });
  }
});

// Replace your existing '/api/wordpress/publish-with-recipe' endpoint in server.js with this enhanced version

app.post('/api/wordpress/publish-with-recipe', isAuthenticated, activityMiddleware.logActivity('publish', 'post'), async (req, res) => {
  try {
    const { recipeId, status, customContent, customTitle, formatContent = true, seoMetadata = null, includeFeaturedImage = true } = req.body;
    
    if (!recipeId && !customContent) {
      return res.status(400).json({
        success: false,
        message: 'Either Recipe ID or custom content is required'
      });
    }
    
    // Get WordPress settings
    const wpSettings = await wordpressDb.getSettings(req.session.user.id);
    if (!wpSettings || !wpSettings.site_url || !wpSettings.username || !wpSettings.password) {
      return res.status(400).json({
        success: false,
        message: 'WordPress settings are not configured. Please set up your WordPress connection first.'
      });
    }
    
    // Get WP Recipe Maker settings
    const recipeDbModule = require('./wordpress-recipe-db');
    const wprmSettings = await recipeDbModule.getSettings();
    
    let content, title, metaSlug = '';
    let recipeData = null;
    let focusKeyword = null;
    let autoSeoMetadata = null;
    let featuredImagePath = null; // NEW: Track featured image
    
    // If using an existing recipe
    if (recipeId) {
      // Get recipe details
      const recipe = await recipeDb.getRecipeById(recipeId);
      if (!recipe) {
        return res.status(404).json({
          success: false,
          message: 'Recipe not found'
        });
      }
      
      // Store recipe idea as the focus keyword
      focusKeyword = recipe.recipe_idea; 
      
      // Get blog content
      const blog = await blogDb.getBlogContentByRecipeId(recipeId);
      if (!blog || !blog.html_content) {
        return res.status(404).json({
          success: false,
          message: 'No blog content found for this recipe'
        });
      }
      
      content = blog.html_content;
      title = recipe.recipe_idea;
      
      // NEW: Get the latest Midjourney image for this recipe
      if (includeFeaturedImage) {
        try {
          const recipeImage = await db.getOne(
            "SELECT image_path FROM recipe_images WHERE recipe_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
            [recipeId]
          );
          
          if (recipeImage && recipeImage.image_path) {
            const imagePath = path.join(process.cwd(), 'recipe_images', recipeImage.image_path);
            if (fs.existsSync(imagePath)) {
              featuredImagePath = imagePath;
              console.log(`✅ Found featured image for recipe: ${recipeImage.image_path}`);
            } else {
              console.warn(`⚠️ Image file not found: ${imagePath}`);
            }
          } else {
            console.log(`ℹ️ No Midjourney image found for recipe ${recipeId}`);
          }
        } catch (imageError) {
          console.warn('Warning: Error getting recipe image:', imageError.message);
          // Continue without image
        }
      }
      
      // Get Pinterest variation for meta info
      if (blog.pinterest_variation_id) {
        const variation = await pinterestDb.getVariationById(blog.pinterest_variation_id);
        if (variation) {
          title = variation.meta_title || title;
          metaSlug = variation.meta_slug || '';
          
          // Create auto SEO metadata object from Pinterest variation
          autoSeoMetadata = {
            title: variation.meta_title || title,
            description: variation.meta_description || '',
            permalink: variation.meta_slug || '',
            keyword: focusKeyword
          };
        }
      } else {
        // Try to get the first variation
        const variations = await pinterestDb.getVariationsByRecipeId(recipeId);
        if (variations && variations.length > 0) {
          title = variations[0].meta_title || title;
          metaSlug = variations[0].meta_slug || '';
          
          // Create auto SEO metadata object from Pinterest variation
          autoSeoMetadata = {
            title: variations[0].meta_title || title,
            description: variations[0].meta_description || '',
            permalink: variations[0].meta_slug || '',
            keyword: focusKeyword
          };
        }
      }
      
      // Get Facebook content to extract recipe data
      const facebookContent = await facebookDb.getFacebookContentByRecipeId(recipeId);
      if (facebookContent) {
        // Require recipe helper module
        const recipeHelper = require('./recipe-helper');
        recipeData = recipeHelper.extractRecipeFromFacebookContent(facebookContent);
        
        // Log the extracted recipe data for debugging
        console.log('Extracted recipe data from Facebook content:');
        console.log('- Title:', recipeData?.title);
        console.log('- Ingredients:', recipeData?.ingredients?.length || 0);
        console.log('- Instructions:', recipeData?.instructions?.length || 0);
        
        // Make sure original arrays are set
        if (recipeData && recipeData.ingredients && !recipeData._originalIngredients) {
          recipeData._originalIngredients = [...recipeData.ingredients];
        }
        
        if (recipeData && recipeData.instructions && !recipeData._originalInstructions) {
          recipeData._originalInstructions = [...recipeData.instructions];
        }
      } else {
        console.warn('No Facebook content found for this recipe');
      }
    } else {
      // Use custom content and title
      content = customContent;
      title = customTitle || 'Custom Content';
      
      // If SEO metadata was provided directly, use it
      if (seoMetadata && seoMetadata.keyword) {
        focusKeyword = seoMetadata.keyword;
      }
    }
    
    // Create the post data
    const postData = {
      title: title,
      content: content,
      status: status || wpSettings.default_status || 'draft',
      slug: metaSlug,
      formatContent: formatContent
    };
    
    // Initialize WordPress client
    const WordPressClient = require('./wordpress');
    const wp = new WordPressClient({
      siteUrl: wpSettings.site_url,
      username: wpSettings.username,
      password: wpSettings.password
    });
    
    let result;
    
    // NEW: Create post with featured image
    const imageAltText = `${title} - Recipe Image`;
    const postResult = await wp.createPostWithFeaturedImage(postData, featuredImagePath, imageAltText);
    
    // Continue with recipe and SEO processing
    if (recipeData && wprmSettings.enabled) {
      // Check if we should add recipe based on title
      const shouldAdd = wprmSettings.addToAllPosts || 
                        WordPressClient.shouldAddRecipe(title, wprmSettings);
                        
      console.log(`Should add recipe? ${shouldAdd}`);
      
      if (shouldAdd) {
        // Add the recipe to the existing post
        const recipeHelper = require('./recipe-helper');
        const recipeResult = await recipeHelper.addRecipeToPost(
          {
            apiUrl: `${wpSettings.site_url}/wp-json/wp/v2`,
            username: wpSettings.username,
            password: wpSettings.password
          },
          recipeData,
          postResult.id
        );
        
        result = {
          success: true,
          post: postResult,
          recipe: recipeResult,
          featuredImage: featuredImagePath ? {
            localPath: featuredImagePath,
            wordpressUrl: postResult.featured_image_url
          } : null
        };
      } else {
        result = {
          success: true,
          post: postResult,
          featuredImage: featuredImagePath ? {
            localPath: featuredImagePath,
            wordpressUrl: postResult.featured_image_url
          } : null
        };
      }
    } else {
      result = {
        success: true,
        post: postResult,
        featuredImage: featuredImagePath ? {
          localPath: featuredImagePath,
          wordpressUrl: postResult.featured_image_url
        } : null
      };
    }
    
    // Apply SEO metadata
    const metadataToApply = seoMetadata || autoSeoMetadata || { 
      title: title,
      description: '',
      permalink: metaSlug,
      keyword: focusKeyword
    };
    
    if (metadataToApply && metadataToApply.keyword) {
      try {
        console.log('Applying SEO metadata with focus keyword:', metadataToApply.keyword);
        await wp.applySeoMetadata(postResult.id, metadataToApply);
        console.log('✅ SEO metadata with focus keyword applied successfully');
        result.seo = { focusKeyword: metadataToApply.keyword };
      } catch (seoError) {
        console.error('Error applying SEO metadata:', seoError.message);
        // Continue despite SEO error
      }
    }
    
    // Save publication record if using an existing recipe
    if (recipeId) {
      await wordpressDb.savePublication({
        recipeId: recipeId,
        wpPostId: result.post.id,
        wpPostUrl: result.post.link,
        wpStatus: result.post.status,
        websiteId: req.session.currentWebsiteId
      });
      
      // If a recipe was added, log it
      if (result.recipe && result.recipe.success && result.recipe.recipeId) {
        await recipeDbModule.logRecipePublication({
          recipeId: recipeId,
          wpPostId: result.post.id,
          wprmRecipeId: result.recipe.recipeId
        });
      }
    }
    
    res.json({
      success: true,
      post: {
        id: result.post.id,
        url: result.post.link,
        status: result.post.status,
        title: result.post.title?.rendered || title,
        featured_image_url: result.post.featured_image_url || null
      },
      recipe: result.recipe || null,
      seo: result.seo || null,
      featuredImage: result.featuredImage || null
    });
  } catch (error) {
    console.error('Error publishing to WordPress with recipe:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to publish to WordPress'
    });
  }
});

// Publish to WordPress with content formatting
app.post('/api/wordpress/publish-formatted', isAuthenticated, activityMiddleware.logActivity('publish', 'post'), async (req, res) => {
  try {
    const { recipeId, status, customContent, customTitle, formatContent = true } = req.body;
    
    if (!recipeId && !customContent) {
      return res.status(400).json({
        success: false,
        message: 'Either Recipe ID or custom content is required'
      });
    }
    
    // Get WordPress settings
    const settings = await wordpressDb.getSettings(req.session.user.id);
    if (!settings || !settings.site_url || !settings.username || !settings.password) {
      return res.status(400).json({
        success: false,
        message: 'WordPress settings are not configured. Please set up your WordPress connection first.'
      });
    }
    
    let content, title, metaSlug = '';
    
    // If using an existing recipe
    if (recipeId) {
      // Get recipe details
      const recipe = await recipeDb.getRecipeById(recipeId);
      if (!recipe) {
        return res.status(404).json({
          success: false,
          message: 'Recipe not found'
        });
      }
      
      // Get blog content
      const blog = await blogDb.getBlogContentByRecipeId(recipeId);
      if (!blog || !blog.html_content) {
        return res.status(404).json({
          success: false,
          message: 'No blog content found for this recipe'
        });
      }
      
      content = blog.html_content;
      title = recipe.recipe_idea;
      
      // Get Pinterest variation for meta info
      if (blog.pinterest_variation_id) {
        const variation = await pinterestDb.getVariationById(blog.pinterest_variation_id);
        if (variation) {
          title = variation.meta_title || title;
          metaSlug = variation.meta_slug || '';
        }
      } else {
        // Try to get the first variation
        const variations = await pinterestDb.getVariationsByRecipeId(recipeId);
        if (variations && variations.length > 0) {
          title = variations[0].meta_title || title;
          metaSlug = variations[0].meta_slug || '';
        }
      }
    } else {
      // Use custom content and title
      content = customContent;
      title = customTitle || 'Custom Content';
    }
    
    // Initialize WordPress client
    const wp = new WordPressClient({
      siteUrl: settings.site_url,
      username: settings.username,
      password: settings.password
    });
    
    // Create the post
    const postData = {
      title: title,
      content: content,
      status: status || settings.default_status || 'draft',
      slug: metaSlug,
      formatContent: formatContent
    };
    
    const result = await wp.createPost(postData);
    
    // Save publication record if using an existing recipe
    if (recipeId) {
      await wordpressDb.savePublication({
        recipeId: recipeId,
        wpPostId: result.id,
        wpPostUrl: result.link,
        wpStatus: result.status,
        websiteId: req.session.currentWebsiteId
      });
    }
    
    res.json({
      success: true,
      post: {
        id: result.id,
        url: result.link,
        status: result.status,
        title: result.title.rendered
      }
    });
  } catch (error) {
    console.error('Error publishing to WordPress:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to publish to WordPress'
    });
  }
});

// Get WordPress publication history for a recipe
app.get('/api/wordpress/publications/:recipeId',isAuthenticated, async (req, res) => {
  try {
    const recipeId = req.params.recipeId;
    
    if (!recipeId) {
      return res.status(400).json({
        success: false,
        message: 'Recipe ID is required'
      });
    }
    
    const publications = await wordpressDb.getPublicationsByRecipeId(recipeId);
    
    res.json({
      success: true,
      publications: publications || []
    });
  } catch (error) {
    console.error('Error fetching WordPress publications:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch WordPress publications'
    });
  }
});

// Get WordPress settings API endpoint
app.get('/api/wordpress/settings', isAuthenticated, async (req, res) => {
  try {
    const settings = await wordpressDb.getSettings(req.session.user.id);
    
    if (settings && settings.site_url && settings.username && settings.password) {
      res.json({
        success: true,
        settings: {
          site_url: settings.site_url,
          username: settings.username,
          // Don't send the actual password to the client
          hasPassword: true,
          default_status: settings.default_status || 'draft'
        }
      });
    } else {
      res.json({
        success: false,
        message: 'WordPress settings not configured'
      });
    }
  } catch (error) {
    console.error('Error fetching WordPress settings via API:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch WordPress settings: ' + error.message
    });
  }
});

// Apply SEO metadata to a WordPress post
app.post('/api/wordpress/apply-seo', isAuthenticated, async (req, res) => {
  try {
    const { postId, seoMetadata } = req.body;
    
    if (!postId || !seoMetadata) {
      return res.status(400).json({
        success: false,
        message: 'Post ID and SEO metadata are required'
      });
    }
    
    // Get WordPress settings
    const settings = await wordpressDb.getSettings(req.session.user.id);
    if (!settings || !settings.site_url || !settings.username || !settings.password) {
      return res.status(400).json({
        success: false,
        message: 'WordPress settings are not configured. Please set up your WordPress connection first.'
      });
    }
    
    // Initialize WordPress client
    const wp = new WordPressClient({
      siteUrl: settings.site_url,
      username: settings.username,
      password: settings.password
    });
    
    // Apply SEO metadata
    const result = await wp.applySeoMetadata(postId, seoMetadata);
    
    res.json({
      success: true,
      message: 'SEO metadata applied successfully',
      data: result
    });
  } catch (error) {
    console.error('Error applying SEO metadata:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to apply SEO metadata'
    });
  }
});

// API endpoint for filtered content (admin only)
// Now replace the API endpoint in your server.js file with this updated version

// API endpoint for filtered content (admin only)
app.get('/api/filtered-content', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    const employeeId = req.query.employeeId || null;
    const contentType = req.query.type || 'all';
    
    // Use the new helper function that handles missing tables gracefully
    const result = await getFilteredContent(organizationId, employeeId, contentType);
    
    res.json(result);
  } catch (error) {
    console.error('Error getting filtered content:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load filtered content',
      error: error.message
    });
  }
});

// Simple function to convert recipe data to CSV
function convertRecipesToCSV(recipes) {
  // Define fields for the CSV
  const fields = [
    { label: 'Recipe Title', value: 'title' },
    { label: 'Ingredient 1', value: 'ingredient1' },
    { label: 'Ingredient 2', value: 'ingredient2' },
    { label: 'Ingredient 3', value: 'ingredient3' },
    { label: 'Ingredient 4', value: 'ingredient4' },
    { label: 'Image Path', value: 'imagePath' },
  ];

  // Process recipes to extract required data
  const processedData = recipes.map(recipe => {
    // Extract title from recipe
    const title = recipe.recipe_idea || '';

    // Extract ingredients
    let ingredientsList = [];
    if (recipe.facebook && recipe.facebook.ingredientsList) {
      // If we have a Facebook post with ingredients
      ingredientsList = recipe.facebook.ingredientsList;
    } else if (recipe.facebook && recipe.facebook.recipe_text) {
      // Try to extract ingredients from recipe text
      const recipeText = recipe.facebook.recipe_text;
      const ingredientsMatch = recipeText.match(/INGREDIENTS\s*([\s\S]*?)(?:INSTRUCTIONS|STEPS|$)/i);
      
      if (ingredientsMatch && ingredientsMatch[1]) {
        ingredientsList = ingredientsMatch[1]
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && line.length > 1)
          .map(line => line.replace(/^[-•\s]+|[-•\s]+$/g, '').trim());
      }
    }

    // Ensure we have at least 4 elements (even if empty)
    while (ingredientsList.length < 4) {
      ingredientsList.push('');
    }

    // Take only the first 4 ingredients
    ingredientsList = ingredientsList.slice(0, 4);

    // Get the image path
    let imagePath = '';
    // First check if the recipe has a processed midjourney image
    if (recipe.image_path) {
      imagePath = recipe.image_path;
    } else {
      // If no direct image path, try to find the first image in recipe_images directory
      const recipeId = recipe.id;
      if (recipeId) {
        try {
          const recipeImagesDir = path.join(__dirname, 'recipe_images');
          if (fs.existsSync(recipeImagesDir)) {
            const files = fs.readdirSync(recipeImagesDir);
            const recipeImages = files.filter(file => 
              file.startsWith(`recipe_${recipeId}`) && file.endsWith('.webp')
            );
            
            if (recipeImages.length > 0) {
              // Sort by timestamp to get the most recent
              recipeImages.sort((a, b) => {
                const timestampA = a.match(/_(\d+)\./);
                const timestampB = b.match(/_(\d+)\./);
                if (timestampA && timestampB) {
                  return parseInt(timestampB[1]) - parseInt(timestampA[1]);
                }
                return 0;
              });
              
              imagePath = `/recipe_images/${recipeImages[0]}`;
            }
          }
        } catch (error) {
          console.error('Error finding recipe image:', error);
        }
      }
    }

    // Prepare the data object for this recipe
    return {
      title,
      ingredient1: ingredientsList[0],
      ingredient2: ingredientsList[1],
      ingredient3: ingredientsList[2],
      ingredient4: ingredientsList[3],
      imagePath
    };
  });

  // Convert to CSV
  try {
    const parser = new Parser({ fields });
    return parser.parse(processedData);
  } catch (err) {
    console.error('Error converting to CSV:', err);
    throw err;
  }
}

// Replace the existing /api/export/recipe/:id/csv endpoint
app.get('/api/export/recipe/:id/csv', auth.isAuthenticated, async (req, res) => {
  try {
    const recipeId = req.params.id;
    console.log(`Exporting single recipe to CSV: ${recipeId}`);
    
    // Get recipe directly using recipeDb
    const recipe = await recipeDb.getRecipeById(recipeId);
    
    if (!recipe) {
      console.log(`Recipe not found: ${recipeId}`);
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }
    
    // Get the Facebook content for this recipe
    let facebook = null;
    try {
      facebook = await facebookDb.getFacebookContentByRecipeId(recipeId);
      if (facebook) {
        recipe.facebook = facebook;
      }
    } catch (fbError) {
      console.warn(`Error getting Facebook content for recipe ${recipeId}:`, fbError.message);
      // Continue without Facebook content
    }
    
    // Try to get recipe images from the database
    try {
      // Import the DB module
      const db = require('./db');
      
      // Get images from recipe_images table
      const images = await db.getAll(
        "SELECT * FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC",
        [recipeId]
      );
      
      if (images && images.length > 0) {
        recipe.recipe_images = images;
        console.log(`Retrieved ${images.length} images for recipe ${recipeId}`);
      } else {
        console.log(`No images found in database for recipe ${recipeId}`);
      }
    } catch (imgError) {
      console.warn(`Error getting recipe images from database: ${imgError.message}`);
      // Continue without database images
    }
    
    // Load the csvExporter module directly
    const csvExporter = require('./recipe-csv-exporter');
    
    // Make sure the module loaded properly
    if (!csvExporter || typeof csvExporter.exportRecipeToCSV !== 'function') {
      console.error('CSV Exporter module not loaded correctly for single recipe export!');
      return res.status(500).json({
        success: false,
        message: 'CSV Export functionality not available'
      });
    }
    
    // Generate CSV
    const csv = csvExporter.exportRecipeToCSV(recipe);
    
    // Set headers for CSV download
    res.setHeader('Content-Disposition', `attachment; filename="recipe-${recipeId}.csv"`);
    res.setHeader('Content-Type', 'text/csv');
    
    // Send the CSV
    res.send(csv);
  } catch (error) {
    console.error('Error exporting recipe to CSV:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export recipe to CSV', 
      error: error.message 
    });
  }
});

// Replace your Excel export endpoint in server.js with this fixed version
app.get('/api/export/recipes/excel', auth.isAuthenticated, async (req, res) => {
  try {
    console.log('Exporting recipes to Excel format with embedded images');
    
    // Get organization ID from session
    const organizationId = req.session.user.organizationId;
    console.log(`Organization ID: ${organizationId}`);
    
    // Get filter parameters from query string
    const { category, userId, limit = 20 } = req.query;
    
    // Set up filters based on user role
    let recipes = [];
    
    if (req.session.user.role === 'employee') {
      // Employees only see their recipes
      console.log(`Getting recipes for employee: ${req.session.user.id}`);
      recipes = await recipeDb.getRecipesByOwnerAndOrg(
        req.session.user.id, 
        organizationId, 
        parseInt(limit), 
        0
      );
    } else {
      // Admins see all recipes in their organization
      console.log(`Getting all recipes for organization: ${organizationId}`);
      recipes = await recipeDb.getRecipesByOrg(
        organizationId,
        parseInt(limit), 
        0
      );
    }
    
    if (!recipes || recipes.length === 0) {
      console.log('No recipes found for export');
      return res.status(404).json({ success: false, message: 'No recipes found' });
    }
    
    console.log(`Found ${recipes.length} recipes for export`);
    
    // For each recipe, get its Facebook content and images
    for (const recipe of recipes) {
      try {
        // Get Facebook content
        const facebook = await facebookDb.getFacebookContentByRecipeId(recipe.id);
        if (facebook) {
          recipe.facebook = facebook;
          console.log(`Retrieved Facebook content for recipe ${recipe.id}`);
        }
        
        // Try to get recipe images from the database
        try {
          // Import the DB module
          const db = require('./db');
          
          // Get images from recipe_images table
          const images = await db.getAll(
            "SELECT * FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC",
            [recipe.id]
          );
          
          if (images && images.length > 0) {
            recipe.recipe_images = images;
            console.log(`Retrieved ${images.length} images for recipe ${recipe.id}`);
          } else {
            console.log(`No images found in database for recipe ${recipe.id}`);
          }
        } catch (imgError) {
          console.warn(`Error getting recipe images from database: ${imgError.message}`);
          // Continue without database images
        }
      } catch (fbError) {
        console.warn(`Error getting Facebook content for recipe ${recipe.id}:`, fbError.message);
        // Continue without Facebook content for this recipe
      }
    }
    
    try {
      // Make sure we load the Excel exporter, not the CSV one
      delete require.cache[require.resolve('./recipe-excel-exporter')];
      const excelExporter = require('./recipe-excel-exporter');
      
      console.log('Excel exporter functions:', Object.keys(excelExporter));
      
      // Just check if the exporter has the required function, don't check the type
      if (!excelExporter || !excelExporter.exportRecipesToExcel) {
        throw new Error('exportRecipesToExcel function not found in exporter module');
      }
      
      // Generate Excel file with embedded images
      console.log('Generating Excel with embedded images...');
      const excelBuffer = await excelExporter.exportRecipesToExcel(recipes);
      
      // Set headers for Excel download
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="recipes-with-images.xlsx"');
      res.setHeader('Content-Length', excelBuffer.length);
      
      // Send the Excel file
      console.log('Sending Excel response');
      res.send(excelBuffer);
      
    } catch (excelError) {
      console.error('Excel generation error:', excelError);
      return res.status(500).json({
        success: false,
        message: `Excel generation failed: ${excelError.message}`,
        error: excelError.stack
      });
    }
  } catch (error) {
    console.error('Error exporting recipes to Excel:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export recipes to Excel', 
      error: error.message 
    });
  }
});

// Add this new endpoint for single recipe Excel export
app.get('/api/export/recipe/:id/excel', auth.isAuthenticated, async (req, res) => {
  try {
    const recipeId = req.params.id;
    console.log(`Exporting single recipe to Excel: ${recipeId}`);
    
    // Get recipe directly using recipeDb
    const recipe = await recipeDb.getRecipeById(recipeId);
    
    if (!recipe) {
      console.log(`Recipe not found: ${recipeId}`);
      return res.status(404).json({ success: false, message: 'Recipe not found' });
    }
    
    // Check if user has access to this recipe (same logic as in /recipe/:id route)
    const orgId = req.session.user.organizationId;
    const userId = req.session.user.role === 'employee' ? req.session.user.id : null;
    
    if (recipe.organization_id !== orgId || 
        (userId && recipe.owner_id !== userId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    // Get the Facebook content for this recipe
    let facebook = null;
    try {
      facebook = await facebookDb.getFacebookContentByRecipeId(recipeId);
      if (facebook) {
        recipe.facebook = facebook;
      }
    } catch (fbError) {
      console.warn(`Error getting Facebook content for recipe ${recipeId}:`, fbError.message);
    }
    
    // Get recipe images from the database
    try {
      const db = require('./db');
      const images = await db.getAll(
        "SELECT * FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC",
        [recipeId]
      );
      
      if (images && images.length > 0) {
        recipe.recipe_images = images;
        console.log(`Retrieved ${images.length} images for recipe ${recipeId}`);
      }
    } catch (imgError) {
      console.warn(`Error getting recipe images from database: ${imgError.message}`);
    }
    
    // Load the Excel exporter module
    const excelExporter = require('./recipe-excel-exporter');
    
    if (!excelExporter || !excelExporter.exportRecipeToExcel) {
      console.error('Excel Exporter module not loaded correctly for single recipe export!');
      return res.status(500).json({
        success: false,
        message: 'Excel Export functionality not available'
      });
    }
    
    // Generate Excel file
    const excelBuffer = await excelExporter.exportRecipeToExcel(recipe);
    
    // Set headers for Excel download
    res.setHeader('Content-Disposition', `attachment; filename="recipe-${recipe.recipe_idea.replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    // Send the Excel file
    res.send(excelBuffer);
  } catch (error) {
    console.error('Error exporting recipe to Excel:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export recipe to Excel', 
      error: error.message 
    });
  }
});

// Add this endpoint to your server.js file to check and fix keyword status consistency

// Endpoint to check and fix keyword status consistency
app.post('/api/admin/fix-keyword-statuses', isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log('🔧 [ADMIN] Starting keyword status consistency check...');
    
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    
    // Set global context
    global.currentWebsiteId = websiteId;
    
    // Find keywords that should be 'processed' but are still 'pending'
    // These are keywords that have a recipe_id but status is still 'pending'
    let problemQuery = `
      SELECT k.id, k.keyword, k.status, k.recipe_id, k.website_id,
             r.id as recipe_exists,
             fb.id as facebook_exists,
             p.id as pinterest_exists
      FROM keywords k
      LEFT JOIN recipes r ON k.recipe_id = r.id
      LEFT JOIN facebook_content fb ON k.recipe_id = fb.recipe_id
      LEFT JOIN pinterest_variations p ON k.recipe_id = p.recipe_id
      WHERE k.organization_id = ?
        AND k.recipe_id IS NOT NULL
        AND k.status = 'pending'
    `;
    
    let params = [organizationId];
    
    if (websiteId) {
      problemQuery += ` AND k.website_id = ?`;
      params.push(websiteId);
    }
    
    const problemKeywords = await getAll(problemQuery, params);
    
    console.log(`🔍 [ADMIN] Found ${problemKeywords.length} keywords with status inconsistencies`);
    
    const fixes = [];
    let fixedCount = 0;
    
    for (const keyword of problemKeywords) {
      try {
        console.log(`🔧 [ADMIN] Checking keyword ${keyword.id}: "${keyword.keyword}"`);
        
        // Check if this keyword has generated content
        const hasContent = keyword.recipe_exists && (keyword.facebook_exists || keyword.pinterest_exists);
        
        if (hasContent) {
          console.log(`✅ [ADMIN] Keyword ${keyword.id} has content, should be 'processed'`);
          
          // Update status to processed
          const updateResult = await keywordsDb.updateKeywordStatus(
            keyword.id, 
            'processed', 
            keyword.recipe_id, 
            websiteId
          );
          
          if (updateResult) {
            fixedCount++;
            fixes.push({
              id: keyword.id,
              keyword: keyword.keyword,
              action: 'updated_to_processed',
              success: true
            });
            console.log(`✅ [ADMIN] Fixed keyword ${keyword.id} status`);
          } else {
            fixes.push({
              id: keyword.id,
              keyword: keyword.keyword,
              action: 'update_failed',
              success: false
            });
            console.error(`❌ [ADMIN] Failed to update keyword ${keyword.id} status`);
          }
        } else {
          console.log(`⚠️ [ADMIN] Keyword ${keyword.id} has recipe_id but no content - marking as failed`);
          
          // Update status to failed since there's no content
          const updateResult = await keywordsDb.updateKeywordStatus(
            keyword.id, 
            'failed', 
            null, 
            websiteId
          );
          
          if (updateResult) {
            fixes.push({
              id: keyword.id,
              keyword: keyword.keyword,
              action: 'updated_to_failed',
              success: true
            });
          } else {
            fixes.push({
              id: keyword.id,
              keyword: keyword.keyword,
              action: 'update_failed',
              success: false
            });
          }
        }
        
      } catch (error) {
        console.error(`❌ [ADMIN] Error fixing keyword ${keyword.id}:`, error);
        fixes.push({
          id: keyword.id,
          keyword: keyword.keyword,
          action: 'error',
          success: false,
          error: error.message
        });
      }
    }
    
    // Also check for orphaned recipes (recipes without keywords)
    let orphanQuery = `
      SELECT r.id, r.recipe_idea
      FROM recipes r
      LEFT JOIN keywords k ON r.id = k.recipe_id
      WHERE r.organization_id = ? AND k.id IS NULL
    `;
    
    let orphanParams = [organizationId];
    
    if (websiteId) {
      orphanQuery += ` AND r.website_id = ?`;
      orphanParams.push(websiteId);
    }
    
    const orphanRecipes = await getAll(orphanQuery, orphanParams);
    
    console.log(`🏗️ [ADMIN] Found ${orphanRecipes.length} orphaned recipes`);
    
    res.json({
      success: true,
      message: `Fixed ${fixedCount} keyword status inconsistencies`,
      details: {
        problemKeywords: problemKeywords.length,
        fixedCount: fixedCount,
        fixes: fixes,
        orphanRecipes: orphanRecipes.length,
        orphanRecipesList: orphanRecipes.slice(0, 10) // Show first 10
      }
    });
    
  } catch (error) {
    console.error('❌ [ADMIN] Error in keyword status consistency check:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      error: error.stack
    });
  }
});

// Endpoint to get keyword status summary for debugging
app.get('/api/admin/keyword-status-summary', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    
    // Get status summary
    let summaryQuery = `
      SELECT 
        status,
        COUNT(*) as count,
        COUNT(CASE WHEN recipe_id IS NOT NULL THEN 1 END) as with_recipe_id,
        COUNT(CASE WHEN recipe_id IS NULL THEN 1 END) as without_recipe_id
      FROM keywords 
      WHERE organization_id = ?
    `;
    
    let params = [organizationId];
    
    if (websiteId) {
      summaryQuery += ` AND website_id = ?`;
      params.push(websiteId);
    }
    
    summaryQuery += ` GROUP BY status`;
    
    const statusSummary = await getAll(summaryQuery, params);
    
    // Get potential problems
    let problemsQuery = `
      SELECT 
        'pending_with_recipe' as issue_type,
        COUNT(*) as count
      FROM keywords k
      WHERE k.organization_id = ? 
        AND k.status = 'pending' 
        AND k.recipe_id IS NOT NULL
    `;
    
    let problemsParams = [organizationId];
    
    if (websiteId) {
      problemsQuery += ` AND k.website_id = ?`;
      problemsParams.push(websiteId);
    }
    
    const problems = await getAll(problemsQuery, problemsParams);
    
    res.json({
      success: true,
      summary: {
        statusBreakdown: statusSummary,
        potentialProblems: problems,
        websiteId: websiteId,
        organizationId: organizationId
      }
    });
    
  } catch (error) {
    console.error('❌ [ADMIN] Error getting keyword status summary:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Add this endpoint to your server.js file for immediate web-based fixing

// Emergency fix endpoint for stuck pending keywords
app.post('/api/emergency/fix-pending-keywords', isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log('🚨 [EMERGENCY] Starting emergency fix for pending keywords...');
    
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    
    // Get all keywords that are marked as 'pending' but have recipe_id and content
    let query = `
      SELECT 
        k.id, 
        k.keyword, 
        k.status, 
        k.recipe_id, 
        k.website_id,
        r.id as recipe_exists,
        fb.id as facebook_content_exists,
        pv.id as pinterest_content_exists,
        ri.id as recipe_image_exists
      FROM keywords k
      LEFT JOIN recipes r ON k.recipe_id = r.id
      LEFT JOIN facebook_content fb ON k.recipe_id = fb.recipe_id
      LEFT JOIN pinterest_variations pv ON k.recipe_id = pv.recipe_id
      LEFT JOIN recipe_images ri ON k.recipe_id = ri.recipe_id
      WHERE k.status = 'pending' 
        AND k.recipe_id IS NOT NULL
        AND k.organization_id = ?
    `;
    
    let params = [organizationId];
    
    if (websiteId) {
      query += ` AND k.website_id = ?`;
      params.push(websiteId);
    }
    
    query += ` ORDER BY k.added_at DESC`;
    
    const stuckKeywords = await getAll(query, params);
    
    console.log(`📊 [EMERGENCY] Found ${stuckKeywords.length} stuck keywords to fix`);
    
    const results = {
      total: stuckKeywords.length,
      fixed: 0,
      failed: 0,
      details: []
    };
    
    for (const keyword of stuckKeywords) {
      try {
        // Check if keyword has any content
        const hasContent = keyword.recipe_exists && 
                          (keyword.facebook_content_exists || 
                           keyword.pinterest_content_exists || 
                           keyword.recipe_image_exists);
        
        if (hasContent) {
          console.log(`✅ [EMERGENCY] Fixing keyword "${keyword.keyword}" - has content`);
          
          // Direct SQL update without website filter complications
          const updateResult = await runQuery(`
            UPDATE keywords 
            SET status = 'processed', 
                processed_at = CURRENT_TIMESTAMP 
            WHERE id = ? AND organization_id = ?
          `, [keyword.id, organizationId]);
          
          if (updateResult.changes > 0) {
            results.fixed++;
            results.details.push({
              id: keyword.id,
              keyword: keyword.keyword,
              action: 'updated_to_processed',
              success: true
            });
            console.log(`    ✅ Fixed keyword ${keyword.id}`);
          } else {
            results.failed++;
            results.details.push({
              id: keyword.id,
              keyword: keyword.keyword,
              action: 'update_failed',
              success: false,
              error: 'No rows updated'
            });
            console.log(`    ❌ Failed to update keyword ${keyword.id}`);
          }
        } else {
          console.log(`⚠️ [EMERGENCY] Keyword "${keyword.keyword}" has recipe but no content - marking as failed`);
          
          const updateResult = await runQuery(`
            UPDATE keywords 
            SET status = 'failed', 
                processed_at = CURRENT_TIMESTAMP,
                recipe_id = NULL
            WHERE id = ? AND organization_id = ?
          `, [keyword.id, organizationId]);
          
          if (updateResult.changes > 0) {
            results.fixed++;
            results.details.push({
              id: keyword.id,
              keyword: keyword.keyword,
              action: 'updated_to_failed',
              success: true
            });
          } else {
            results.failed++;
            results.details.push({
              id: keyword.id,
              keyword: keyword.keyword,
              action: 'update_failed',
              success: false
            });
          }
        }
        
      } catch (error) {
        console.error(`❌ [EMERGENCY] Error fixing keyword ${keyword.id}:`, error);
        results.failed++;
        results.details.push({
          id: keyword.id,
          keyword: keyword.keyword,
          action: 'error',
          success: false,
          error: error.message
        });
      }
    }
    
    // Final check
    const remainingStuck = await getOne(`
      SELECT COUNT(*) as count
      FROM keywords 
      WHERE status = 'pending' 
        AND recipe_id IS NOT NULL 
        AND organization_id = ?
        ${websiteId ? 'AND website_id = ?' : ''}
    `, websiteId ? [organizationId, websiteId] : [organizationId]);
    
    console.log(`🎉 [EMERGENCY] Fix complete: ${results.fixed} fixed, ${results.failed} failed`);
    console.log(`📊 [EMERGENCY] Remaining stuck: ${remainingStuck.count}`);
    
    res.json({
      success: true,
      message: `Emergency fix completed: ${results.fixed} keywords fixed, ${results.failed} failed`,
      results: results,
      remainingStuck: remainingStuck.count
    });
    
  } catch (error) {
    console.error('❌ [EMERGENCY] Critical error in emergency fix:', error);
    res.status(500).json({
      success: false,
      message: 'Emergency fix failed: ' + error.message,
      error: error.stack
    });
  }
});

// Quick status check endpoint
app.get('/api/emergency/keyword-status-check', isAuthenticated, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    
    // Get status summary
    let statusQuery = `
      SELECT 
        status,
        COUNT(*) as count,
        COUNT(CASE WHEN recipe_id IS NOT NULL THEN 1 END) as with_recipe_id
      FROM keywords 
      WHERE organization_id = ?
    `;
    
    let params = [organizationId];
    
    if (websiteId) {
      statusQuery += ` AND website_id = ?`;
      params.push(websiteId);
    }
    
    statusQuery += ` GROUP BY status ORDER BY count DESC`;
    
    const statusSummary = await getAll(statusQuery, params);
    
    // Get stuck keywords count
    let stuckQuery = `
      SELECT COUNT(*) as count
      FROM keywords k
      WHERE k.status = 'pending' 
        AND k.recipe_id IS NOT NULL
        AND k.organization_id = ?
    `;
    
    let stuckParams = [organizationId];
    
    if (websiteId) {
      stuckQuery += ` AND k.website_id = ?`;
      stuckParams.push(websiteId);
    }
    
    const stuckCount = await getOne(stuckQuery, stuckParams);
    
    res.json({
      success: true,
      summary: {
        statusBreakdown: statusSummary,
        stuckKeywords: stuckCount.count,
        websiteId: websiteId,
        organizationId: organizationId
      }
    });
    
  } catch (error) {
    console.error('❌ Error in status check:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Export selected recipes to Excel
app.post('/api/export/recipes/excel/selected', auth.isAuthenticated, async (req, res) => {
  try {
    const { recipeIds } = req.body;
    
    if (!recipeIds || !Array.isArray(recipeIds) || recipeIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No recipes selected for export' 
      });
    }
    
    console.log(`Exporting ${recipeIds.length} selected recipes to Excel`);
    
    // Get organization ID from session
    const organizationId = req.session.user.organizationId;
    const userId = req.session.user.role === 'employee' ? req.session.user.id : null;
    
    // Get the selected recipes
    const recipes = [];
    
    for (const recipeId of recipeIds) {
      try {
        const recipe = await recipeDb.getRecipeById(recipeId);
        
        if (!recipe) {
          console.warn(`Recipe not found: ${recipeId}`);
          continue;
        }
        
        // Check if user has access to this recipe
        if (recipe.organization_id !== organizationId || 
            (userId && recipe.owner_id !== userId)) {
          console.warn(`Access denied for recipe: ${recipeId}`);
          continue;
        }
        
        // Get Facebook content for this recipe
        try {
          const facebook = await facebookDb.getFacebookContentByRecipeId(recipeId);
          if (facebook) {
            recipe.facebook = facebook;
          }
        } catch (fbError) {
          console.warn(`Error getting Facebook content for recipe ${recipeId}:`, fbError.message);
        }
        
        // Get recipe images from the database
        try {
          const db = require('./db');
          const images = await db.getAll(
            "SELECT * FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC",
            [recipeId]
          );
          
          if (images && images.length > 0) {
            recipe.recipe_images = images;
          }
        } catch (imgError) {
          console.warn(`Error getting recipe images for recipe ${recipeId}:`, imgError.message);
        }
        
        recipes.push(recipe);
      } catch (error) {
        console.error(`Error processing recipe ${recipeId}:`, error);
        continue;
      }
    }
    
    if (recipes.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No accessible recipes found for export' 
      });
    }
    
    console.log(`Successfully processed ${recipes.length} recipes for export`);
    
    // Load the Excel exporter module
    const excelExporter = require('./recipe-excel-exporter');
    
    if (!excelExporter || !excelExporter.exportRecipesToExcel) {
      console.error('Excel Exporter module not loaded correctly!');
      return res.status(500).json({
        success: false,
        message: 'Excel Export functionality not available'
      });
    }
    
    // Generate Excel file with embedded images
    console.log('Generating Excel with embedded images...');
    const excelBuffer = await excelExporter.exportRecipesToExcel(recipes);
    
    // Set headers for Excel download
    const filename = `selected-recipes-${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', excelBuffer.length);
    
    // Send the Excel file
    console.log('Sending Excel response');
    res.send(excelBuffer);
    
  } catch (error) {
    console.error('Error exporting selected recipes to Excel:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export selected recipes to Excel: ' + error.message,
      error: error.stack
    });
  }
});

// API endpoint to diagnose recipe image issues
app.get('/api/diagnose-images/:recipeId?', auth.isAuthenticated, async (req, res) => {
  try {
    // Get the recipe ID from params or query
    const recipeId = req.params.recipeId || req.query.recipeId;
    
    // Define the recipe_images directory
    const recipeImagesDir = path.join(__dirname, 'recipe_images');
    
    // Check if the directory exists
    const dirExists = fs.existsSync(recipeImagesDir);
    
    // Get list of files in the directory
    let files = [];
    if (dirExists) {
      files = fs.readdirSync(recipeImagesDir);
    }
    
    // If a specific recipe ID is provided, get detailed info for that recipe
    let recipeInfo = null;
    if (recipeId) {
      // Get the recipe details
      const recipe = await recipeDb.getRecipeById(recipeId);
      
      if (recipe) {
        // Get associated images from database
        const db = require('./db');
        const images = await db.getAll(
          "SELECT * FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC",
          [recipeId]
        );
        
        // Find matching files in the directory
        const matchingFiles = files.filter(file => file.includes(recipeId));
        
        // Check if each image file exists
        const imageChecks = [];
        if (images && images.length > 0) {
          for (const img of images) {
            const imagePath = img.image_path;
            const fullPath = path.join(recipeImagesDir, imagePath);
            const justFilename = path.basename(imagePath);
            const altPath = path.join(recipeImagesDir, justFilename);
            
            imageChecks.push({
              id: img.id,
              image_path: imagePath,
              fullPathExists: fs.existsSync(fullPath),
              fullPath: fullPath,
              altPathExists: fs.existsSync(altPath),
              altPath: altPath
            });
          }
        }
        
        recipeInfo = {
          recipe: recipe,
          dbImages: images || [],
          matchingFiles: matchingFiles,
          imageChecks: imageChecks
        };
      }
    }
    
    // Return the diagnostic info
    res.json({
      success: true,
      recipeImagesDir: recipeImagesDir,
      directoryExists: dirExists,
      fileCount: files.length,
      sampleFiles: files.slice(0, 10),
      recipeInfo: recipeInfo
    });
  } catch (error) {
    console.error('Error in image diagnostic:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API key diagnostic endpoints
app.get('/api/diagnose-keys', async (req, res) => {
  try {
    const dbStatus = await apiKeyManager.checkApiKeyTable();
    const hasKey = await apiKeyManager.getApiKey('openai');
    const hasEnvKey = process.env.OPENAI_API_KEY ? true : false;
    const configApiKey = promptConfig.apiKey ? true : false;
    
    res.json({
      success: true,
      database: dbStatus,
      apiKeys: {
        openai: {
          found: hasKey ? true : false,
          source: hasKey ? 'Retrieved successfully' : 'Not found'
        }
      },
      environment: {
        OPENAI_API_KEY: hasEnvKey
      },
      config: {
        apiKey: configApiKey
      }
    });
  } catch (error) {
    console.error('Error in API key diagnostic:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add a visual diagnostic page
app.get('/diagnose-keys', async (req, res) => {
  try {
    // Check database status
    const dbStatus = await apiKeyManager.checkApiKeyTable();
    
    // Try to get the OpenAI API key
    const hasKey = await apiKeyManager.getApiKey('openai');
    
    // Check environment variables
    const hasEnvKey = process.env.OPENAI_API_KEY ? true : false;
    
    // Get in-memory config
    const configApiKey = promptConfig.apiKey ? true : false;
    
    res.send(`
      <html>
        <head>
          <title>API Key Diagnostic</title>
          <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css" rel="stylesheet">
        </head>
        <body>
          <div class="container my-5">
            <h1>API Key Diagnostic</h1>
            
            <div class="card mb-4">
              <div class="card-header">
                <h5>Database Status</h5>
              </div>
              <div class="card-body">
                <pre>${JSON.stringify(dbStatus, null, 2)}</pre>
              </div>
            </div>
            
            <div class="card mb-4">
              <div class="card-header">
                <h5>API Key Status</h5>
              </div>
              <div class="card-body">
                <p>OpenAI API Key: <span class="badge ${hasKey ? 'bg-success' : 'bg-danger'}">${hasKey ? 'Found' : 'Not Found'}</span></p>
              </div>
            </div>
            
            <div class="card mb-4">
              <div class="card-header">
                <h5>Environment Variables</h5>
              </div>
              <div class="card-body">
                <p>OPENAI_API_KEY: <span class="badge ${hasEnvKey ? 'bg-success' : 'bg-danger'}">${hasEnvKey ? 'Set' : 'Not Set'}</span></p>
              </div>
            </div>
            
            <div class="card mb-4">
              <div class="card-header">
                <h5>In-Memory Config</h5>
              </div>
              <div class="card-body">
                <p>apiKey: <span class="badge ${configApiKey ? 'bg-success' : 'bg-danger'}">${configApiKey ? 'Set' : 'Not Set'}</span></p>
              </div>
            </div>
            
            <a href="/settings" class="btn btn-primary">Back to Settings</a>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error in API key diagnostic page:', error);
    res.status(500).send(`
      <html>
        <head>
          <title>API Key Diagnostic Error</title>
          <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css" rel="stylesheet">
        </head>
        <body>
          <div class="container my-5">
            <div class="alert alert-danger">
              <h4>Error</h4>
              <p>${error.message}</p>
            </div>
            <a href="/settings" class="btn btn-primary">Back to Settings</a>
          </div>
        </body>
      </html>
    `);
  }
});

// API endpoint to get detailed queue information
app.get('/api/image-queue/status', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const organizationId = req.session.user.organizationId;
    
    // Get user's queue status
    const queueStatus = await imageQueueService.getQueueStatus(userId, organizationId);
    
    // Get overall system stats (for admins)
    let systemStats = null;
    if (req.session.user.role === 'admin') {
      try {
        const { getAll, getOne } = require('./db');
        
        // Get system-wide queue statistics
        const stats = await getAll(`
          SELECT 
            status,
            COUNT(*) as count,
            AVG(CASE 
              WHEN completed_at IS NOT NULL AND started_at IS NOT NULL 
              THEN (julianday(completed_at) - julianday(started_at)) * 24 * 60 * 60 
            END) as avg_processing_time_seconds
          FROM image_queue 
          WHERE created_at > datetime('now', '-24 hours')
          GROUP BY status
        `);
        
        // Get recent activity
        const recentActivity = await getAll(`
          SELECT iq.*, r.recipe_idea, u.name as user_name
          FROM image_queue iq
          LEFT JOIN recipes r ON iq.recipe_id = r.id
          LEFT JOIN users u ON iq.user_id = u.id
          WHERE iq.organization_id = ?
          ORDER BY iq.created_at DESC
          LIMIT 10
        `, [organizationId]);
        
        systemStats = {
          stats: stats,
          recentActivity: recentActivity
        };
      } catch (statsError) {
        console.error('Error getting system stats:', statsError);
      }
    }
    
    res.json({
      success: true,
      ...queueStatus,
      systemStats: systemStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to cancel a queued job
app.post('/api/image-queue/cancel/:jobId', isAuthenticated, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const userId = req.session.user.id;
    
    const result = await imageQueueService.cancelJob(jobId, userId);
    
    if (result.success) {
      res.json({
        success: true,
        message: result.message
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.message
      });
    }
  } catch (error) {
    console.error('Error cancelling job:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to add a recipe to the image generation queue
app.post('/api/image-queue/add', isAuthenticated, async (req, res) => {
  try {
    const { recipeId, customPrompt } = req.body;
    
    if (!recipeId) {
      return res.status(400).json({
        success: false,
        error: 'Recipe ID is required'
      });
    }
    
    // Validate recipe exists and user has access
    const recipe = await getOne("SELECT * FROM recipes WHERE id = ?", [recipeId]);
    if (!recipe) {
      return res.status(404).json({
        success: false,
        error: 'Recipe not found'
      });
    }
    
    // Check user permissions
    const orgId = req.session.user.organizationId;
    const userId = req.session.user.role === 'employee' ? req.session.user.id : null;
    
    if (recipe.organization_id !== orgId || 
        (userId && recipe.owner_id !== userId)) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to generate images for this recipe'
      });
    }
    
    // Check for existing pending job
    const existingJob = await getOne(`
      SELECT * FROM image_queue 
      WHERE recipe_id = ? AND status IN ('queued', 'processing')
    `, [recipeId]);
    
    if (existingJob) {
      return res.json({
        success: false,
        error: 'This recipe already has a pending image generation',
        existingJob: {
          id: existingJob.id,
          position: existingJob.position,
          estimatedCompletion: existingJob.estimated_completion
        }
      });
    }
    
    // Get Discord settings
    const discordSettings = global.getCurrentDiscordSettings ? 
      global.getCurrentDiscordSettings(req) : null;
    
    if (!discordSettings || !discordSettings.enableDiscord) {
      return res.status(400).json({
        success: false,
        error: 'Discord integration is not configured. Please check your settings.'
      });
    }
    
    // Add to queue
    const queueResult = await imageQueueService.addToQueue({
      recipeId: parseInt(recipeId),
      userId: req.session.user.id,
      organizationId: req.session.user.organizationId,
      websiteId: req.session.currentWebsiteId,
      customPrompt: customPrompt || null,
      discordSettings: discordSettings
    });
    
    res.json({
      success: true,
      message: 'Recipe added to image generation queue successfully',
      job: {
        id: queueResult.jobId,
        position: queueResult.position,
        estimatedCompletion: queueResult.estimatedCompletion,
        queueLength: queueResult.queueLength
      }
    });
    
  } catch (error) {
    console.error('Error adding to queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin-only endpoint to get detailed queue statistics
app.get('/api/admin/image-queue/stats', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { getAll, getOne } = require('./db');
    
    // Get comprehensive queue statistics
    const stats = await getAll(`
      SELECT 
        status,
        COUNT(*) as count,
        AVG(CASE 
          WHEN completed_at IS NOT NULL AND started_at IS NOT NULL 
          THEN (julianday(completed_at) - julianday(started_at)) * 24 * 60 * 60 
        END) as avg_processing_time_seconds,
        MIN(created_at) as earliest_job,
        MAX(created_at) as latest_job
      FROM image_queue 
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY status
    `);
    
    // Get user statistics
    const userStats = await getAll(`
      SELECT 
        u.name,
        COUNT(*) as total_jobs,
        COUNT(CASE WHEN iq.status = 'completed' THEN 1 END) as completed_jobs,
        COUNT(CASE WHEN iq.status = 'failed' THEN 1 END) as failed_jobs,
        AVG(CASE 
          WHEN iq.completed_at IS NOT NULL AND iq.started_at IS NOT NULL 
          THEN (julianday(iq.completed_at) - julianday(iq.started_at)) * 24 * 60 * 60 
        END) as avg_processing_time
      FROM image_queue iq
      JOIN users u ON iq.user_id = u.id
      WHERE iq.created_at > datetime('now', '-7 days')
        AND iq.organization_id = ?
      GROUP BY u.id, u.name
      ORDER BY total_jobs DESC
    `, [req.session.user.organizationId]);
    
    // Get recent failures with details
    const recentFailures = await getAll(`
      SELECT iq.*, r.recipe_idea, u.name as user_name
      FROM image_queue iq
      LEFT JOIN recipes r ON iq.recipe_id = r.id
      LEFT JOIN users u ON iq.user_id = u.id
      WHERE iq.status = 'failed' 
        AND iq.organization_id = ?
        AND iq.created_at > datetime('now', '-24 hours')
      ORDER BY iq.created_at DESC
      LIMIT 20
    `, [req.session.user.organizationId]);
    
    // Get performance metrics
    const performanceMetrics = await getOne(`
      SELECT 
        COUNT(*) as total_jobs_today,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_today,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_today,
        COUNT(CASE WHEN status IN ('queued', 'processing') THEN 1 END) as active_jobs,
        ROUND(
          100.0 * COUNT(CASE WHEN status = 'completed' THEN 1 END) / 
          NULLIF(COUNT(CASE WHEN status IN ('completed', 'failed') THEN 1 END), 0), 
          2
        ) as success_rate_percent
      FROM image_queue 
      WHERE created_at > datetime('now', '-24 hours')
        AND organization_id = ?
    `, [req.session.user.organizationId]);
    
    res.json({
      success: true,
      stats: {
        byStatus: stats,
        byUser: userStats,
        performance: performanceMetrics,
        recentFailures: recentFailures
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error getting admin queue stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin-only endpoint to manage queue (pause/resume, clear failed jobs, etc.)
app.post('/api/admin/image-queue/manage', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const { action, jobIds } = req.body;
    
    switch (action) {
      case 'clear_failed':
        const clearResult = await runQuery(`
          DELETE FROM image_queue 
          WHERE status = 'failed' 
            AND organization_id = ? 
            AND created_at < datetime('now', '-24 hours')
        `, [req.session.user.organizationId]);
        
        res.json({
          success: true,
          message: `Cleared ${clearResult.changes || 0} failed jobs`,
          clearedCount: clearResult.changes || 0
        });
        break;
        
      case 'clear_completed':
        const clearCompletedResult = await runQuery(`
          DELETE FROM image_queue 
          WHERE status = 'completed' 
            AND organization_id = ? 
            AND created_at < datetime('now', '-7 days')
        `, [req.session.user.organizationId]);
        
        res.json({
          success: true,
          message: `Cleared ${clearCompletedResult.changes || 0} completed jobs`,
          clearedCount: clearCompletedResult.changes || 0
        });
        break;
        
      case 'retry_failed':
        if (!jobIds || !Array.isArray(jobIds)) {
          return res.status(400).json({
            success: false,
            error: 'Job IDs array is required for retry action'
          });
        }
        
        // Reset failed jobs to queued status
        const retryResult = await runQuery(`
          UPDATE image_queue 
          SET status = 'queued', 
              error_message = NULL,
              retry_count = retry_count + 1,
              position = (SELECT MAX(position) FROM image_queue WHERE status IN ('queued', 'processing')) + 1,
              estimated_completion = datetime('now', '+' || (SELECT MAX(position) FROM image_queue WHERE status IN ('queued', 'processing')) * 90 || ' seconds')
          WHERE id IN (${jobIds.map(() => '?').join(',')}) 
            AND status = 'failed'
            AND organization_id = ?
        `, [...jobIds, req.session.user.organizationId]);
        
        res.json({
          success: true,
          message: `Retried ${retryResult.changes || 0} failed jobs`,
          retriedCount: retryResult.changes || 0
        });
        break;
        
      default:
        res.status(400).json({
          success: false,
          error: 'Invalid action. Supported actions: clear_failed, clear_completed, retry_failed'
        });
    }
    
  } catch (error) {
    console.error('Error managing queue:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint to get queue health status
app.get('/api/image-queue/health', isAuthenticated, async (req, res) => {
  try {
    const { getOne } = require('./db');
    
    // Check for stuck jobs (processing for more than 10 minutes)
    const stuckJobs = await getOne(`
      SELECT COUNT(*) as count
      FROM image_queue 
      WHERE status = 'processing' 
        AND started_at < datetime('now', '-10 minutes')
    `);
    
    // Check queue size
    const queueSize = await getOne(`
      SELECT COUNT(*) as count
      FROM image_queue 
      WHERE status = 'queued'
    `);
    
    // Check recent failure rate
    const recentStats = await getOne(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM image_queue 
      WHERE created_at > datetime('now', '-1 hour')
    `);
    
    const failureRate = recentStats.total > 0 ? 
      (recentStats.failed / recentStats.total) * 100 : 0;
    
    // Determine health status
    let healthStatus = 'healthy';
    let issues = [];
    
    if (stuckJobs.count > 0) {
      healthStatus = 'warning';
      issues.push(`${stuckJobs.count} jobs appear to be stuck`);
    }
    
    if (queueSize.count > 20) {
      healthStatus = 'warning';
      issues.push(`Queue is large (${queueSize.count} jobs)`);
    }
    
    if (failureRate > 50) {
      healthStatus = 'critical';
      issues.push(`High failure rate (${failureRate.toFixed(1)}%)`);
    }
    
    res.json({
      success: true,
      health: {
        status: healthStatus,
        issues: issues,
        metrics: {
          stuckJobs: stuckJobs.count,
          queueSize: queueSize.count,
          recentFailureRate: Math.round(failureRate * 100) / 100
        }
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error checking queue health:', error);
    res.json({
      success: false,
      health: {
        status: 'error',
        issues: ['Unable to check queue health'],
        error: error.message
      },
      timestamp: new Date().toISOString()
    });
  }
});

// WebSocket or Server-Sent Events for real-time updates (optional enhancement)
app.get('/api/image-queue/events', isAuthenticated, (req, res) => {
  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  const userId = req.session.user.id;
  const organizationId = req.session.user.organizationId;
  
  // Send initial status
  const sendUpdate = async () => {
    try {
      const status = await imageQueueService.getQueueStatus(userId, organizationId);
      const data = JSON.stringify(status);
      res.write(`data: ${data}\n\n`);
    } catch (error) {
      console.error('Error sending SSE update:', error);
    }
  };
  
  // Send updates every 5 seconds
  const interval = setInterval(sendUpdate, 5000);
  
  // Send initial update
  sendUpdate();
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
  });
});

// API endpoint to toggle prompt debugging
app.post('/api/toggle-debug-prompts', isAuthenticated, isAdmin, (req, res) => {
  try {
    // Toggle debug mode
    global.debugPrompts = !global.debugPrompts;
    
    // Log current status
    console.log(`\n${global.debugPrompts ? 'Enabled' : 'Disabled'} prompt debugging\n`);
    
    res.json({
      success: true,
      debugPrompts: global.debugPrompts,
      message: `Prompt debugging ${global.debugPrompts ? 'enabled' : 'disabled'}`
    });
  } catch (error) {
    console.error('Error toggling debug mode:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// API endpoint to get debug mode status
app.get('/api/debug-prompts-status', isAuthenticated, isAdmin, (req, res) => {
  try {
    res.json({
      success: true,
      debugPrompts: global.debugPrompts || false
    });
  } catch (error) {
    console.error('Error getting debug mode status:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// API endpoint to get prompt logs list
app.get('/api/prompt-logs', isAuthenticated, isAdmin, (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const logsDir = path.join(__dirname, 'prompt_logs');
    if (!fs.existsSync(logsDir)) {
      return res.json({
        success: true,
        logs: []
      });
    }
    
    const files = fs.readdirSync(logsDir)
      .filter(file => file.endsWith('.txt'))
      .map(file => {
        const filePath = path.join(logsDir, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size,
          created: stats.mtime
        };
      })
      .sort((a, b) => b.created - a.created); // Newest first
    
    res.json({
      success: true,
      logs: files
    });
  } catch (error) {
    console.error('Error listing prompt logs:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// API endpoint to get a specific prompt log
app.get('/api/prompt-logs/:filename', isAuthenticated, isAdmin, (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const filename = req.params.filename;
    // Security check to prevent directory traversal
    if (filename.includes('../') || filename.includes('..\\')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid filename'
      });
    }
    
    const logsDir = path.join(__dirname, 'prompt_logs');
    const filePath = path.join(logsDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Log file not found'
      });
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({
      success: true,
      filename: filename,
      content: content
    });
  } catch (error) {
    console.error('Error reading prompt log:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Replace the existing /midjourney/api/recipe/:recipeId endpoint in server.js

// API endpoint to get recipe images status - IMPROVED VERSION
app.get('/midjourney/api/recipe/:recipeId', isAuthenticated, async (req, res) => {
  try {
    const recipeId = req.params.recipeId;
    
    if (!recipeId) {
      return res.status(400).json({
        success: false,
        message: 'Recipe ID is required'
      });
    }
    
    console.log(`🔍 [API] Getting image status for recipe: ${recipeId}`);
    
    // Get all images for this recipe from the recipe_images table
    // CRITICAL: Use a fresh query, not cached data
    const images = await db.getAll(
      "SELECT id, recipe_id, status, image_path, prompt, created_at, error, discord_message_id FROM recipe_images WHERE recipe_id = ? ORDER BY created_at DESC",
      [recipeId]
    );
    
    console.log(`📊 [API] Database query returned ${images.length} images`);
    
    if (!images || images.length === 0) {
      console.log(`ℹ️ [API] No images found for recipe ${recipeId}`);
      return res.json({
        success: true,
        images: [],
        message: 'No images found for this recipe'
      });
    }
    
    // Log each image for debugging
    images.forEach((img, index) => {
      console.log(`📷 [API] Image ${index + 1}:`, {
        id: img.id,
        status: img.status,
        image_path: img.image_path,
        created_at: img.created_at,
        has_error: !!img.error
      });
      
      if (img.error) {
        console.log(`   ⚠️ Error: ${img.error}`);
      }
    });
    
    // Process the images data
    const processedImages = images.map(img => {
      const processedImg = {
        id: img.id,
        recipe_id: img.recipe_id,
        status: img.status,
        image_path: img.image_path,
        prompt: img.prompt,
        created_at: img.created_at,
        error: img.error,
        discord_message_id: img.discord_message_id
      };
      
      // Add additional computed fields
      if (img.image_path) {
        processedImg.image_url = `/recipe_images/${img.image_path}`;
        
        // Check if file actually exists
        const fs = require('fs');
        const path = require('path');
        const fullPath = path.join(process.cwd(), 'recipe_images', img.image_path);
        processedImg.file_exists = fs.existsSync(fullPath);
        
        if (!processedImg.file_exists) {
          console.warn(`⚠️ [API] Image file not found: ${fullPath}`);
        }
      }
      
      return processedImg;
    });
    
    // Get summary statistics
    const stats = {
      total: images.length,
      completed: images.filter(img => img.status === 'completed').length,
      pending: images.filter(img => img.status === 'pending').length,
      generating: images.filter(img => img.status === 'generating').length,
      failed: images.filter(img => img.status === 'failed').length
    };
    
    console.log(`📈 [API] Image statistics for recipe ${recipeId}:`, stats);
    
    // Return the images with their status
    const response = {
      success: true,
      recipe_id: recipeId,
      images: processedImages,
      stats: stats,
      timestamp: new Date().toISOString()
    };
    
    console.log(`✅ [API] Returning ${processedImages.length} images for recipe ${recipeId}`);
    
    // Set headers to prevent caching
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.json(response);
    
  } catch (error) {
    console.error(`❌ [API] Error getting recipe images for ${req.params.recipeId}:`, error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get recipe images',
      error_details: error.stack,
      timestamp: new Date().toISOString()
    });
  }
});
// Add this test endpoint to your server.js (temporarily, for debugging)

// Test endpoint to verify database updates work correctly
app.post('/api/test-db-update/:imageId', isAuthenticated, async (req, res) => {
  try {
    const imageId = req.params.imageId;
    const { status, image_path } = req.body;
    
    console.log(`🧪 [TEST] Testing database update for image ID: ${imageId}`);
    
    // Get current state
    const beforeUpdate = await db.getOne(
      "SELECT * FROM recipe_images WHERE id = ?",
      [imageId]
    );
    
    if (!beforeUpdate) {
      return res.status(404).json({
        success: false,
        message: 'Image record not found',
        imageId: imageId
      });
    }
    
    console.log(`📊 [TEST] Before update:`, {
      id: beforeUpdate.id,
      status: beforeUpdate.status,
      image_path: beforeUpdate.image_path
    });
    
    // Perform update
    const updateResult = await db.runQuery(
      "UPDATE recipe_images SET status = ?, image_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [status || 'test-completed', image_path || 'test-image.png', imageId]
    );
    
    console.log(`🔄 [TEST] Update result:`, updateResult);
    
    // Verify update
    const afterUpdate = await db.getOne(
      "SELECT * FROM recipe_images WHERE id = ?",
      [imageId]
    );
    
    console.log(`📊 [TEST] After update:`, {
      id: afterUpdate.id,
      status: afterUpdate.status,
      image_path: afterUpdate.image_path
    });
    
    const success = afterUpdate.status === (status || 'test-completed');
    
    res.json({
      success: success,
      message: success ? 'Database update test successful' : 'Database update test failed',
      before: {
        status: beforeUpdate.status,
        image_path: beforeUpdate.image_path
      },
      after: {
        status: afterUpdate.status,
        image_path: afterUpdate.image_path
      },
      updateResult: updateResult
    });
    
  } catch (error) {
    console.error(`❌ [TEST] Database update test failed:`, error);
    res.status(500).json({
      success: false,
      message: 'Database update test failed',
      error: error.message
    });
  }
});

// API endpoint for updating user
app.post('/api/users/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const { name, email, role, password } = req.body;
        
        // Validate required fields
        if (!name || !email || !role) {
            return res.status(400).json({
                success: false,
                message: 'Name, email, and role are required.'
            });
        }
        
        // Update user
        const updateResult = await userDb.updateUser(userId, {
            name,
            email,
            role,
            password: password ? password : undefined // Only update password if provided
        });
        
        if (updateResult) {
            res.json({
                success: true,
                message: 'User updated successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to update user'
            });
        }
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'An unknown error occurred'
        });
    }
});

// API endpoint for deleting user
app.post('/api/users/:id/delete', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        
        // Don't allow deleting your own account
        if (userId === req.session.user.id) {
            return res.status(400).json({
                success: false,
                message: 'You cannot delete your own account.'
            });
        }
        
        // Delete user
        const deleteResult = await userDb.deleteUser(userId);
        
        if (deleteResult) {
            res.json({
                success: true,
                message: 'User deleted successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to delete user'
            });
        }
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'An unknown error occurred'
        });
    }
});

// Bulk recipe deletion endpoint
app.post('/api/recipes/bulk-delete', isAuthenticated, async (req, res) => {
  try {
    const { recipeIds } = req.body;
    
    if (!recipeIds || !Array.isArray(recipeIds) || recipeIds.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid recipe IDs provided' 
      });
    }
    
    // Delete recipes using your recipeDb module
    let deletedCount = 0;
    for (const recipeId of recipeIds) {
      const result = await recipeDb.deleteRecipe(recipeId);
      if (result) deletedCount++;
    }
    
    res.json({ 
      success: true, 
      deletedCount: deletedCount,
      message: `Successfully deleted ${deletedCount} recipes`
    });
  } catch (error) {
    console.error('Error in bulk delete:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to delete recipes: ' + error.message 
    });
  }
});

// Alternative endpoint to delete recipes (using POST)
app.post('/api/recipes/delete/:id',isAuthenticated, async (req, res) => {
  console.log('POST delete endpoint hit with ID:', req.params.id);
  try {
    const recipeId = req.params.id;
    
    if (!recipeId) {
      console.log('No recipe ID provided');
      return res.status(400).json({
        success: false,
        message: 'Recipe ID is required'
      });
    }
    
    console.log('Checking if recipe exists:', recipeId);
    // Check if the recipe exists first
    const recipe = await recipeDb.getRecipeById(recipeId);
    if (!recipe) {
      console.log('Recipe not found with ID:', recipeId);
      return res.status(404).json({
        success: false,
        message: 'Recipe not found'
      });
    }
    
    console.log('Deleting recipe with ID:', recipeId);
    // Delete the recipe and all its associated content
    const result = await recipeDb.deleteRecipe(recipeId);
    
    if (result) {
      console.log('Successfully deleted recipe');
      return res.json({
        success: true,
        message: 'Recipe deleted successfully'
      });
    } else {
      console.log('Failed to delete recipe - database returned false');
      return res.status(500).json({
        success: false,
        message: 'Failed to delete recipe'
      });
    }
  } catch (error) {
    console.error('Error deleting recipe:', error);
    
    // Make sure we return JSON even in error cases
    return res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// API endpoint to delete a recipe - FIXED VERSION
console.log('Registering DELETE /api/recipes/:id route');
app.delete('/api/recipes/:id', isAuthenticated, async (req, res) => {
  console.log('DELETE endpoint hit with ID:', req.params.id);
  try {
    const recipeId = req.params.id;
    
    if (!recipeId) {
      console.log('No recipe ID provided');
      return res.status(400).json({
        success: false,
        message: 'Recipe ID is required'
      });
    }
    
    console.log('Checking if recipe exists:', recipeId);
    // Check if the recipe exists first
    const recipe = await recipeDb.getRecipeById(recipeId);
    if (!recipe) {
      console.log('Recipe not found with ID:', recipeId);
      return res.status(404).json({
        success: false,
        message: 'Recipe not found'
      });
    }
    
    console.log('Deleting recipe with ID:', recipeId);
    // Delete the recipe and all its associated content
    const result = await recipeDb.deleteRecipe(recipeId);
    
    if (result) {
      console.log('Successfully deleted recipe');
      return res.json({
        success: true,
        message: 'Recipe deleted successfully'
      });
    } else {
      console.log('Failed to delete recipe - database returned false');
      return res.status(500).json({
        success: false,
        message: 'Failed to delete recipe'
      });
    }
  } catch (error) {
    console.error('Error deleting recipe:', error);
    
    // Make sure we return JSON even in error cases
    return res.status(500).json({
      success: false,
      message: error.message || 'An unknown error occurred'
    });
  }
});

// Serve output files (for backward compatibility)
app.use('/output', express.static(path.join(__dirname, 'output')));

// Simple test endpoint for debugging
app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API endpoints are working',
    timestamp: new Date().toISOString(),
    user: req.session?.user?.id || 'not logged in'
  });
});

// CRITICAL: DISCORD TEST ENDPOINT - MOVED BEFORE ERROR HANDLERS
app.post('/api/test-discord-connection', isAuthenticated, async (req, res) => {
  try {
    console.log('Discord connection test requested:', req.body);
    
    const { channelId, userToken, webhookUrl, testMessage } = req.body;
    
    if (!channelId && !webhookUrl) {
      return res.status(400).json({
        success: false,
        message: 'Either Channel ID or Webhook URL is required'
      });
    }
    
    const axios = require('axios');
    
    // Test with webhook if provided
    if (webhookUrl && webhookUrl.trim() !== '') {
      try {
        console.log('Testing Discord webhook:', webhookUrl);
        
        const response = await axios.post(webhookUrl, {
          content: testMessage || 'Test message from RecipeGen AI - Discord connection successful! 🎉'
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        });
        
        console.log('Webhook test successful:', response.status);
        
        return res.json({
          method: 'webhook',
          success: true,
          message: 'Discord webhook test successful! Message sent to Discord.'
        });
        
      } catch (webhookError) {
        console.error('Discord webhook test failed:', webhookError.message);
        
        if (!userToken || !channelId) {
          return res.json({
            method: 'webhook',
            success: false,
            message: `Webhook test failed: ${webhookError.response?.data?.message || webhookError.message}`
          });
        }
      }
    }
    
    // Test with user token if webhook failed or not provided
    if (userToken && userToken.trim() !== '' && channelId && channelId.trim() !== '') {
      try {
        console.log('Testing Discord user token for channel:', channelId);
        
        let cleanToken = userToken.trim();
        
        const response = await axios.post(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          {
            content: testMessage || 'Test message from RecipeGen AI - Discord connection successful! 🎉'
          },
          {
            timeout: 10000,
            headers: {
              'Authorization': cleanToken,
              'Content-Type': 'application/json',
              'User-Agent': 'RecipeGenAI/1.0'
            }
          }
        );
        
        console.log('User token test successful:', response.status);
        
        return res.json({
          method: 'user_token',
          success: true,
          message: 'Discord user token test successful! Message sent to Discord.'
        });
        
      } catch (tokenError) {
        console.error('Discord user token test failed:', tokenError.response?.data || tokenError.message);
        
        let errorMessage = 'User token test failed';
        
        if (tokenError.response) {
          if (tokenError.response.status === 401) {
            errorMessage = 'Invalid Discord token. Please check your token.';
          } else if (tokenError.response.status === 403) {
            errorMessage = 'Permission denied. Bot/User lacks permission to send messages to this channel.';
          } else if (tokenError.response.status === 404) {
            errorMessage = 'Channel not found. Please check your Channel ID.';
          } else {
            errorMessage = `Discord API error: ${tokenError.response.data?.message || tokenError.message}`;
          }
        }
        
        return res.json({
          method: 'user_token',
          success: false,
          message: errorMessage
        });
      }
    }
    
    return res.status(400).json({
      success: false,
      message: 'No valid Discord connection method provided. Please provide either a Webhook URL or both Channel ID and User Token.'
    });
    
  } catch (error) {
    console.error('Discord connection test error:', error);
    res.status(500).json({
      success: false,
      message: `Server error: ${error.message}`
    });
  }
});

// Test Discord settings endpoint
app.post('/api/test-discord-settings', isAuthenticated, async (req, res) => {
  try {
    const MidjourneyClient = require('./midjourney/midjourney-client');
    
    console.log('Testing Discord settings...');
    console.log('Channel ID:', process.env.DISCORD_CHANNEL_ID);
    console.log('User Token present:', !!process.env.DISCORD_USER_TOKEN);
    
    const client = MidjourneyClient.getInstance();
    
    // Try to initialize
    await client.initialize();
    
    res.json({
      success: true,
      message: 'Discord settings are valid and working!'
    });
  } catch (error) {
    console.error('Discord settings test failed:', error);
    res.json({
      success: false,
      message: error.message,
      details: 'Check the server console for detailed error information'
    });
  }
});

// Get cleanup configuration
app.get('/api/keywords/cleanup-config', isAuthenticated, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    
    const keywordCleanupService = require('./services/keyword-cleanup-service');
    const config = await keywordCleanupService.getCleanupConfig(organizationId, websiteId);
    
    res.json({
      success: true,
      config: config
    });
  } catch (error) {
    console.error('Error getting cleanup config:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Update cleanup configuration
app.post('/api/keywords/cleanup-config', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    const { autoCleanupEnabled, cleanupAfterDays, cleanupAction } = req.body;
    
    const keywordCleanupService = require('./services/keyword-cleanup-service');
    await keywordCleanupService.updateCleanupConfig(organizationId, websiteId, {
      autoCleanupEnabled: autoCleanupEnabled === true || autoCleanupEnabled === 'true',
      cleanupAfterDays: parseInt(cleanupAfterDays) || 7,
      cleanupAction: cleanupAction || 'archive'
    });
    
    res.json({
      success: true,
      message: 'Cleanup configuration updated successfully'
    });
  } catch (error) {
    console.error('Error updating cleanup config:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Manual cleanup trigger
app.post('/api/keywords/cleanup', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    const { cleanupAfterDays, action } = req.body;
    
    const keywordCleanupService = require('./services/keyword-cleanup-service');
    const result = await keywordCleanupService.runManualCleanup(organizationId, websiteId, {
      cleanupAfterDays: parseInt(cleanupAfterDays) || 7,
      action: action || 'archive'
    });
    
    res.json({
      success: true,
      message: `Successfully ${result.action}d ${result.cleanedCount} keywords`,
      cleanedCount: result.cleanedCount,
      action: result.action
    });
  } catch (error) {
    console.error('Error running manual cleanup:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get cleanup statistics
app.get('/api/keywords/cleanup-stats', isAuthenticated, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    const websiteId = req.session.currentWebsiteId;
    
    const keywordCleanupService = require('./services/keyword-cleanup-service');
    const stats = await keywordCleanupService.getCleanupStats(organizationId, websiteId);
    
    res.json({
      success: true,
      stats: stats
    });
  } catch (error) {
    console.error('Error getting cleanup stats:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get archived keywords
app.get('/api/keywords/archived', isAuthenticated, async (req, res) => {
  try {
    const organizationId = req.session.user.organizationId;
    const userId = req.session.user.role === 'employee' ? req.session.user.id : null;
    
    const page = parseInt(req.query.page || '1');
    const limit = 50;
    const offset = (page - 1) * limit;
    
    // Get archived keywords
    let query = `
      SELECT k.id, k.keyword, k.category, k.interests, k.status, k.recipe_id,
             k.added_at, k.processed_at, u.name as owner_name, u.role as owner_role
      FROM keywords k
      LEFT JOIN users u ON k.owner_id = u.id
      WHERE k.status = 'archived' AND k.organization_id = ?
    `;
    let params = [organizationId];
    
    if (userId) {
      query += ` AND k.owner_id = ?`;
      params.push(userId);
    }
    
    query += ` ORDER BY k.processed_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    
    const keywords = await getAll(query, params);
    
    // Get total count
    let countQuery = `
      SELECT COUNT(*) as count FROM keywords 
      WHERE status = 'archived' AND organization_id = ?
    `;
    let countParams = [organizationId];
    
    if (userId) {
      countQuery += ` AND owner_id = ?`;
      countParams.push(userId);
    }
    
    const countResult = await getOne(countQuery, countParams);
    const totalCount = countResult ? countResult.count : 0;
    const totalPages = Math.ceil(totalCount / limit);
    
    res.json({
      success: true,
      keywords: keywords,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalCount: totalCount,
        limit: limit
      }
    });
  } catch (error) {
    console.error('Error getting archived keywords:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Initialize the cleanup service when server starts
// Add this near the end of your server.js file, before app.listen()
async function initializeCleanupService() {
  try {
    const keywordCleanupService = require('./services/keyword-cleanup-service');
    await keywordCleanupService.initialize();
  } catch (error) {
    console.error('Failed to initialize cleanup service:', error);
  }
}

// Call this after your server starts
initializeCleanupService();

// Helper function to send Discord message
async function sendDiscordMessage(message, options = {}) {
  try {
    if (!promptConfig.enableDiscord) {
      console.log('Discord integration is disabled');
      return { success: false, message: 'Discord integration is disabled' };
    }
    
    const axios = require('axios');
    let result = null;
    
    // Try webhook first if available
    if (promptConfig.discordWebhookUrl) {
      try {
        await axios.post(promptConfig.discordWebhookUrl, {
          content: message,
          ...options
        });
        
        result = { success: true, method: 'webhook' };
      } catch (webhookError) {
        console.warn('Discord webhook failed:', webhookError.message);
      }
    }
    
    // Try user token if webhook failed or not available
    if (!result && promptConfig.discordUserToken && promptConfig.discordChannelId) {
      try {
        await axios.post(
          `https://discord.com/api/v10/channels/${promptConfig.discordChannelId}/messages`,
          {
            content: message,
            ...options
          },
          {
            headers: {
              'Authorization': promptConfig.discordUserToken,
              'Content-Type': 'application/json'
            }
          }
        );
        
        result = { success: true, method: 'user_token' };
      } catch (tokenError) {
        console.error('Discord user token failed:', tokenError.message);
        result = { success: false, message: tokenError.message };
      }
    }
    
    if (!result) {
      result = { success: false, message: 'No Discord connection method available' };
    }
    
    return result;
  } catch (error) {
    console.error('Error sending Discord message:', error);
    return { success: false, message: error.message };
  }
}


// Add this helper function to your server.js file (after your existing helper functions)

// Helper function to get current Discord settings
function getCurrentDiscordSettings(req = null) {
  try {
    // Try to get from request session first
    if (req && req.session && req.session.user) {
      const organizationId = req.session.user.organizationId;
      const websiteId = req.session.currentWebsiteId;
      
      if (organizationId && websiteId) {
        const settings = promptSettingsDb.loadSettings(organizationId, websiteId);
        
        if (settings && settings.enableDiscord && settings.discordChannelId && settings.discordUserToken) {
          console.log('✅ Retrieved Discord settings from user session');
          return {
            discordChannelId: settings.discordChannelId,
            discordUserToken: settings.discordUserToken,
            enableDiscord: settings.enableDiscord
          };
        }
      }
    }
    
    // Fallback to global promptConfig
    if (promptConfig && promptConfig.enableDiscord && promptConfig.discordChannelId && promptConfig.discordUserToken) {
      console.log('✅ Retrieved Discord settings from global promptConfig');
      return {
        discordChannelId: promptConfig.discordChannelId,
        discordUserToken: promptConfig.discordUserToken,
        enableDiscord: promptConfig.enableDiscord
      };
    }
    
    console.log('⚠️ No Discord settings found');
    return null;
  } catch (error) {
    console.error('Error getting Discord settings:', error);
    return null;
  }
}

// Make this function globally available
global.getCurrentDiscordSettings = getCurrentDiscordSettings;

// Export the Discord helper function for use in other parts of your app
global.sendDiscordMessage = sendDiscordMessage;

// Helper functions for website stats
async function getWebsiteStats(websiteId, userId = null, userRole = null) {
  try {
    // Default stats object
    const stats = {
      recipes: 0,
      pendingKeywords: 0,
      processedKeywords: 0,
      failedKeywords: 0,
      totalKeywords: 0,
      wordpressPosts: 0
    };
    
    // Get recipe count
    if (userRole === 'employee' && userId) {
      stats.recipes = await recipeDb.getRecipeCountByOwner(userId, websiteId);
    } else {
      stats.recipes = await recipeDb.getRecipeCountByOrganization(null, websiteId);
    }
    
    // Get keyword counts
    const keywordParams = userRole === 'employee' ? { ownerId: userId } : {};
    stats.pendingKeywords = await keywordsDb.getKeywordsCount('pending', null, 
      keywordParams.ownerId, null, websiteId);
    stats.processedKeywords = await keywordsDb.getKeywordsCount('processed', null, 
      keywordParams.ownerId, null, websiteId);
    stats.failedKeywords = await keywordsDb.getKeywordsCount('failed', null, 
      keywordParams.ownerId, null, websiteId);
    
    stats.totalKeywords = stats.pendingKeywords + stats.processedKeywords + stats.failedKeywords;
    
    // Try to get WordPress post count if we have WordPress integration
    try {
      stats.wordpressPosts = await wordpressDb.getPublicationCount(
  userRole === 'employee' ? userId : null, 
  null, 
  websiteId
);
    } catch (error) {
      console.log('No WordPress publications found or error counting them:', error.message);
    }
    
    return stats;
  } catch (error) {
    console.error('Error getting website stats:', error);
    return {
      recipes: 0,
      pendingKeywords: 0,
      processedKeywords: 0,
      failedKeywords: 0,
      totalKeywords: 0,
      wordpressPosts: 0
    };
  }
}

// Helper function to get recent content for a website
async function getRecentWebsiteContent(websiteId, userId = null, userRole = null) {
  try {
    const recentContent = [];
    const limit = 10;
    
    // Get recent recipes
    const recipeParams = userRole === 'employee' ? { ownerId: userId } : {};
    const recipes = await recipeDb.getRecipesByOrg(
      null, 
      limit, 
      0, 
      websiteId
    );
    
    if (recipes && recipes.length > 0) {
      recipes.forEach(recipe => {
        recentContent.push({
          id: recipe.id,
          title: recipe.recipe_idea,
          type: 'recipe',
          created_at: recipe.created_at,
          url: `/recipe/${recipe.id}`
        });
      });
    }
    
    // Get recent keywords
    const keywords = await keywordsDb.getKeywords(
      null, 
      limit, 
      0, 
      null,
      userRole === 'employee' ? userId : null,
      null,
      websiteId
    );
    
    if (keywords && keywords.length > 0) {
      keywords.forEach(keyword => {
        recentContent.push({
          id: keyword.id,
          title: keyword.keyword,
          type: 'keyword',
          created_at: keyword.added_at,
          status: keyword.status,
          url: `/keywords?search=${encodeURIComponent(keyword.keyword)}`
        });
      });
    }
    
    // Sort by creation date
    recentContent.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    // Return the most recent items
    return recentContent.slice(0, limit);
  } catch (error) {
    console.error('Error getting recent website content:', error);
    return [];
  }
}

// ==========================================
// ERROR HANDLERS - THESE MUST COME LAST
// ==========================================

// 404 handler - catches all unmatched routes
app.use((req, res, next) => {
  console.log('404 - Route not found:', req.method, req.originalUrl);
  res.status(404).render('error', {
    message: 'Page not found',
    error: { status: 404 },
    pageTitle: 'Error',
    activePage: '',
    title: 'RecipeGen AI - Error'
  });
});

// General error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(err.status || 500).render('error', {
    message: err.message || 'An unexpected error occurred',
    error: err || { status: 500 },
    pageTitle: 'Error',
    activePage: '',
    title: 'RecipeGen AI - Error'
  });
});

// Debug: Print all registered routes (move this to the very end)
const listEndpoints = () => {
  console.log('\n--- REGISTERED ROUTES ---');
  app._router.stack.forEach((r) => {
    if (r.route && r.route.path) {
      Object.keys(r.route.methods).forEach((method) => {
        console.log(`${method.toUpperCase().padEnd(7)} ${r.route.path}`);
      });
    }
  });
  console.log('------------------------\n');
};

// Call this at the very end, after all routes are registered
listEndpoints();

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Discord endpoint should now be accessible at: POST /api/test-discord-connection');
});

module.exports = app;