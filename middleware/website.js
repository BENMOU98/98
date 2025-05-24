// middleware/website.js
const websiteDb = require('../models/website');

async function websiteMiddleware(req, res, next) {
  // Skip if no user is logged in
  if (!req.session || !req.session.user) {
    return next();
  }

  try {
    // Set global context for queries
    if (req.session.currentWebsiteId) {
      global.currentWebsiteId = req.session.currentWebsiteId;
    } else {
      // If no website is selected, get the first one for the organization
      const websites = await websiteDb.getWebsitesByOrganization(req.session.user.organizationId);
      if (websites && websites.length > 0) {
        req.session.currentWebsiteId = websites[0].id;
        global.currentWebsiteId = websites[0].id;
      } else {
        global.currentWebsiteId = null;
      }
    }

    // Add websites to res.locals for all templates
    const websites = await websiteDb.getWebsitesByOrganization(req.session.user.organizationId);
    res.locals.websites = websites;
    res.locals.currentWebsiteId = req.session.currentWebsiteId;

    next();
  } catch (error) {
    console.error('Website middleware error:', error);
    next(error);
  }
}

module.exports = websiteMiddleware;