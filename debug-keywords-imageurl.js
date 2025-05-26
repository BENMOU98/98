// debug-keywords-imageurl.js - Debug script for keyword image URL issues
const { getOne, getAll, runQuery } = require('./db');

async function debugKeywordsAndImageUrls() {
  console.log('🔍 === DEBUGGING KEYWORDS AND IMAGE URLs ===\n');
  
  try {
    // 1. Check keywords table structure
    console.log('📋 1. KEYWORDS TABLE STRUCTURE:');
    console.log('=====================================');
    const keywordsTableInfo = await getAll("PRAGMA table_info(keywords)");
    console.table(keywordsTableInfo);
    console.log('');

    // 2. Check the specific recipe ID that was mentioned in the logs
    const specificRecipeId = 'e65f4e6a-ae21-47a1-ad1b-dc12b3b1d55a';
    console.log(`🎯 2. CHECKING SPECIFIC RECIPE: ${specificRecipeId}`);
    console.log('='.repeat(80));
    
    // Get the recipe details
    const recipe = await getOne("SELECT * FROM recipes WHERE id = ?", [specificRecipeId]);
    if (recipe) {
      console.log('✅ Recipe found:');
      console.log(`   - ID: ${recipe.id}`);
      console.log(`   - Title/Idea: ${recipe.recipe_idea || recipe.title || 'N/A'}`);
      console.log(`   - Created: ${recipe.created_at || 'N/A'}`);
      console.log('');
    } else {
      console.log('❌ Recipe NOT found in database!');
      console.log('');
    }

    // Get keywords for this specific recipe
    const recipeKeywords = await getAll(
      "SELECT * FROM keywords WHERE recipe_id = ? ORDER BY added_at DESC", 
      [specificRecipeId]
    );
    
    console.log(`📊 Keywords for recipe ${specificRecipeId}:`);
    if (recipeKeywords.length > 0) {
      console.log(`   Found ${recipeKeywords.length} keyword(s):`);
      for (let index = 0; index < recipeKeywords.length; index++) {
        const keyword = recipeKeywords[index];
        console.log(`   ${index + 1}. Keyword ID: ${keyword.id}`);
        console.log(`      - Keyword: ${keyword.keyword || 'N/A'}`);
        console.log(`      - Image URL: ${keyword.image_url || 'NULL/EMPTY'}`);
        console.log(`      - Recipe ID: ${keyword.recipe_id}`);
        console.log(`      - Created: ${keyword.added_at || 'N/A'}`);
        console.log(`      - Processed: ${keyword.processed_at || 'N/A'}`);
        console.log('');
      }
    } else {
      console.log('   ❌ NO keywords found for this recipe!');
      console.log('');
    }

    // 3. Search for the specific image URL that was mentioned in logs
    const imageUrlPattern = '497872353_1342460220662000';
    console.log(`🖼️ 3. SEARCHING FOR IMAGE URL PATTERN: ${imageUrlPattern}`);
    console.log('='.repeat(80));
    
    const keywordsWithImageUrl = await getAll(
      "SELECT * FROM keywords WHERE image_url LIKE ? ORDER BY added_at DESC", 
      [`%${imageUrlPattern}%`]
    );
    
    if (keywordsWithImageUrl.length > 0) {
      console.log(`✅ Found ${keywordsWithImageUrl.length} keyword(s) with this image URL:`);
      for (let index = 0; index < keywordsWithImageUrl.length; index++) {
        const keyword = keywordsWithImageUrl[index];
        console.log(`   ${index + 1}. Keyword ID: ${keyword.id}`);
        console.log(`      - Keyword: ${keyword.keyword || 'N/A'}`);
        console.log(`      - Recipe ID: ${keyword.recipe_id}`);
        console.log(`      - Image URL: ${keyword.image_url}`);
        console.log(`      - Created: ${keyword.added_at || 'N/A'}`);
        console.log('');
      }
    } else {
      console.log('❌ NO keywords found with this image URL pattern!');
      console.log('');
    }

    // 4. Check recent keywords (last 10)
    console.log('⏰ 4. RECENT KEYWORDS (LAST 10):');
    console.log('='.repeat(80));
    const recentKeywords = await getAll(
      `SELECT k.*, r.recipe_idea 
       FROM keywords k 
       LEFT JOIN recipes r ON k.recipe_id = r.id 
       ORDER BY k.added_at DESC 
       LIMIT 10`
    );
    
    if (recentKeywords.length > 0) {
      console.log('Recent keywords:');
      for (let index = 0; index < recentKeywords.length; index++) {
        const keyword = recentKeywords[index];
        console.log(`   ${index + 1}. ${keyword.added_at || 'No timestamp'}`);
        console.log(`      - Keyword: ${keyword.keyword || 'N/A'}`);
        console.log(`      - Recipe: ${keyword.recipe_idea || 'N/A'} (${keyword.recipe_id})`);
        console.log(`      - Has Image URL: ${keyword.image_url ? 'YES' : 'NO'}`);
        if (keyword.image_url) {
          console.log(`      - Image URL: ${keyword.image_url.substring(0, 100)}...`);
        }
        console.log('');
      }
    } else {
      console.log('❌ No recent keywords found!');
      console.log('');
    }

    // 5. Check facebook_content for the recipe
    console.log(`📘 5. FACEBOOK CONTENT FOR RECIPE: ${specificRecipeId}`);
    console.log('='.repeat(80));
    const facebookContent = await getAll(
      "SELECT * FROM facebook_content WHERE recipe_id = ? ORDER BY created_at DESC", 
      [specificRecipeId]
    );
    
    if (facebookContent.length > 0) {
      console.log(`✅ Found ${facebookContent.length} facebook content record(s):`);
      for (let index = 0; index < facebookContent.length; index++) {
        const content = facebookContent[index];
        console.log(`   ${index + 1}. FB Content ID: ${content.id}`);
        console.log(`      - Title: ${content.title || 'N/A'}`);
        console.log(`      - MJ Prompt: ${content.mj_prompt ? content.mj_prompt.substring(0, 100) + '...' : 'N/A'}`);
        console.log(`      - Created: ${content.created_at || 'N/A'}`);
        console.log('');
      }
    } else {
      console.log('❌ No facebook content found for this recipe!');
      console.log('');
    }

    // 6. Check for any keywords with NULL or empty image_url
    console.log('🚫 6. KEYWORDS WITH MISSING IMAGE URLs:');
    console.log('='.repeat(80));
    const keywordsWithoutImageUrl = await getAll(
      `SELECT k.*, r.recipe_idea 
       FROM keywords k 
       LEFT JOIN recipes r ON k.recipe_id = r.id 
       WHERE k.image_url IS NULL OR k.image_url = '' 
       ORDER BY k.added_at DESC 
       LIMIT 5`
    );
    
    if (keywordsWithoutImageUrl.length > 0) {
      console.log(`Found ${keywordsWithoutImageUrl.length} keywords without image URLs:`);
      for (let index = 0; index < keywordsWithoutImageUrl.length; index++) {
        const keyword = keywordsWithoutImageUrl[index];
        console.log(`   ${index + 1}. ${keyword.keyword || 'N/A'} (Recipe: ${keyword.recipe_idea || 'N/A'})`);
        console.log(`      - Recipe ID: ${keyword.recipe_id}`);
        console.log(`      - Created: ${keyword.added_at || 'N/A'}`);
        console.log('');
      }
    } else {
      console.log('✅ All keywords have image URLs!');
      console.log('');
    }

    // 7. Check for timing issues - compare recipe, keyword, and facebook_content creation times
    console.log(`⏱️ 7. TIMING ANALYSIS FOR RECIPE: ${specificRecipeId}`);
    console.log('='.repeat(80));
    
    if (recipe) {
      const recipeTime = new Date(recipe.created_at);
      console.log(`Recipe created: ${recipe.created_at} (${recipeTime.toLocaleString()})`);
      
      if (recipeKeywords.length > 0) {
        for (let index = 0; index < recipeKeywords.length; index++) {
          const keyword = recipeKeywords[index];
          const keywordTime = new Date(keyword.added_at);
          const timeDiff = keywordTime.getTime() - recipeTime.getTime();
          console.log(`Keyword ${index + 1} created: ${keyword.added_at} (${keywordTime.toLocaleString()}) - ${timeDiff}ms after recipe`);
        }
      }
      
      if (facebookContent.length > 0) {
        for (let index = 0; index < facebookContent.length; index++) {
          const content = facebookContent[index];
          const contentTime = new Date(content.created_at);
          const timeDiff = contentTime.getTime() - recipeTime.getTime();
          console.log(`FB Content ${index + 1} created: ${content.created_at} (${contentTime.toLocaleString()}) - ${timeDiff}ms after recipe`);
        }
      }
      console.log('');
    }

    // 8. Search for any recipe with "Creamy Parmesan Garlic Beef Pasta" to check if IDs match
    console.log('🍝 8. SEARCHING FOR "Creamy Parmesan Garlic Beef Pasta":');
    console.log('='.repeat(80));
    const pastaRecipes = await getAll(
      "SELECT * FROM recipes WHERE recipe_idea LIKE ? OR title LIKE ?", 
      ['%Creamy Parmesan Garlic Beef Pasta%', '%Creamy Parmesan Garlic Beef Pasta%']
    );
    
    if (pastaRecipes.length > 0) {
      console.log(`✅ Found ${pastaRecipes.length} recipe(s) matching "Creamy Parmesan Garlic Beef Pasta":`);
      for (let index = 0; index < pastaRecipes.length; index++) {
        const recipe = pastaRecipes[index];
        console.log(`   ${index + 1}. Recipe ID: ${recipe.id}`);
        console.log(`      - Title/Idea: ${recipe.recipe_idea || recipe.title || 'N/A'}`);
        console.log(`      - Created: ${recipe.created_at || 'N/A'}`);
        
        // Check if this recipe has keywords
        const recipeKeywordCount = await getOne(
          "SELECT COUNT(*) as count FROM keywords WHERE recipe_id = ?", 
          [recipe.id]
        );
        console.log(`      - Keywords count: ${recipeKeywordCount.count}`);
        
        // Check if this recipe has facebook content
        const recipeFbCount = await getOne(
          "SELECT COUNT(*) as count FROM facebook_content WHERE recipe_id = ?", 
          [recipe.id]
        );
        console.log(`      - Facebook content count: ${recipeFbCount.count}`);
        console.log('');
      }
    } else {
      console.log('❌ No recipes found matching "Creamy Parmesan Garlic Beef Pasta"!');
      console.log('');
    }

    // 9. Check for any duplicate recipe IDs or orphaned records
    console.log('🔄 9. CHECKING FOR DATA CONSISTENCY ISSUES:');
    console.log('='.repeat(80));
    
    // Check for keywords pointing to non-existent recipes
    const orphanedKeywords = await getAll(`
      SELECT k.* FROM keywords k 
      LEFT JOIN recipes r ON k.recipe_id = r.id 
      WHERE r.id IS NULL
      LIMIT 5
    `);
    
    if (orphanedKeywords.length > 0) {
      console.log(`⚠️ Found ${orphanedKeywords.length} orphaned keywords (pointing to non-existent recipes):`);
      for (let index = 0; index < orphanedKeywords.length; index++) {
        const keyword = orphanedKeywords[index];
        console.log(`   ${index + 1}. Keyword: ${keyword.keyword} -> Recipe ID: ${keyword.recipe_id} (MISSING)`);
      }
      console.log('');
    } else {
      console.log('✅ No orphaned keywords found.');
      console.log('');
    }

    // 10. Summary and recommendations
    console.log('📋 10. SUMMARY & RECOMMENDATIONS:');
    console.log('='.repeat(80));
    
    console.log('Key findings:');
    console.log(`- Recipe ${specificRecipeId} exists: ${recipe ? 'YES' : 'NO'}`);
    console.log(`- Keywords for this recipe: ${recipeKeywords.length}`);
    console.log(`- Keywords with the target image URL: ${keywordsWithImageUrl.length}`);
    console.log(`- Facebook content for this recipe: ${facebookContent.length}`);
    console.log('');
    
    if (recipeKeywords.length === 0) {
      console.log('🚨 ISSUE: No keywords found for the target recipe!');
      console.log('   Recommendation: Check the keyword creation/saving logic.');
      console.log('');
    }
    
    if (keywordsWithImageUrl.length > 0 && recipeKeywords.length === 0) {
      console.log('🚨 ISSUE: Image URL exists in keywords table but not linked to target recipe!');
      console.log('   Recommendation: Check recipe_id assignment in keyword creation.');
      console.log('');
    }
    
    if (keywordsWithImageUrl.length === 0) {
      console.log('🚨 ISSUE: The target image URL is not being saved to the database!');
      console.log('   Recommendation: Check the Facebook scraping/keyword saving logic.');
      console.log('');
    }

  } catch (error) {
    console.error('❌ Error during debugging:', error);
    console.error('Stack trace:', error.stack);
  }
}

// Run the debug function
debugKeywordsAndImageUrls()
  .then(() => {
    console.log('🏁 Debug completed!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });