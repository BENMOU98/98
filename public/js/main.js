// Enhanced main.js - JavaScript for the RecipeGen AI application with improved copy functionality

document.addEventListener('DOMContentLoaded', function() {
  // Mobile sidebar toggle
  const toggleSidebarBtn = document.getElementById('toggle-sidebar');
  const sidebar = document.querySelector('.sidebar');
  
  if (toggleSidebarBtn && sidebar) {
    toggleSidebarBtn.addEventListener('click', function() {
      sidebar.classList.toggle('show');
    });
    
    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', function(event) {
      const isClickInsideSidebar = sidebar.contains(event.target);
      const isClickOnToggleBtn = toggleSidebarBtn.contains(event.target);
      
      if (!isClickInsideSidebar && !isClickOnToggleBtn && sidebar.classList.contains('show')) {
        sidebar.classList.remove('show');
      }
    });
  }
  
  // Enhanced copy button functionality using event delegation
  // This will work for both existing and dynamically added buttons
  document.addEventListener('click', function(event) {
    const copyBtn = event.target.closest('.copy-btn');
    if (!copyBtn) return; // Not a copy button click
    
    const contentId = copyBtn.getAttribute('data-content');
    if (!contentId) return; // No content ID specified
    
    const contentElement = document.getElementById(contentId);
    if (!contentElement) return; // Content element not found
    
    // Get content (try innerText first, then textContent as fallback)
    let content = contentElement.innerText || contentElement.textContent;
    
    // Trim whitespace for cleaner copying
    content = content.trim();
    
    // Use modern clipboard API with fallback
    if (navigator.clipboard && window.isSecureContext) {
      // Modern browsers with secure context
      navigator.clipboard.writeText(content)
        .then(() => {
          showCopySuccess(copyBtn);
        })
        .catch(err => {
          console.warn('Clipboard API failed, falling back to execCommand:', err);
          fallbackCopyText(content, copyBtn);
        });
    } else {
      // Fallback for older browsers or non-secure contexts
      fallbackCopyText(content, copyBtn);
    }
      
    // Prevent default and stop propagation
    event.preventDefault();
    event.stopPropagation();
  });
  
  // Enhanced copy success feedback
  function showCopySuccess(button) {
    const originalHTML = button.innerHTML;
    const originalClasses = button.className;
    
    // Update button appearance
    button.innerHTML = '<i class="fa fa-check"></i> Copied!';
    button.classList.add('btn-success');
    button.style.background = 'rgba(60, 213, 175, 0.25)';
    button.style.borderColor = 'rgba(60, 213, 175, 0.4)';
    button.style.color = '#3cd5af';
    
    // Reset after 2 seconds
    setTimeout(() => {
      button.innerHTML = originalHTML;
      button.className = originalClasses;
      button.style.background = '';
      button.style.borderColor = '';
      button.style.color = '';
    }, 2000);
  }
  
  // Fallback copy method for older browsers
  function fallbackCopyText(text, button) {
    try {
      // Create a temporary textarea element
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      
      // Select and copy
      textArea.focus();
      textArea.select();
      
      const successful = document.execCommand('copy');
      document.body.removeChild(textArea);
      
      if (successful) {
        showCopySuccess(button);
      } else {
        throw new Error('execCommand failed');
      }
    } catch (err) {
      console.error('All copy methods failed:', err);
      
      // Show error feedback
      const originalHTML = button.innerHTML;
      button.innerHTML = '<i class="fa fa-exclamation-triangle"></i> Failed';
      button.style.background = 'rgba(255, 59, 48, 0.25)';
      button.style.borderColor = 'rgba(255, 59, 48, 0.4)';
      button.style.color = '#ff3b30';
      
      setTimeout(() => {
        button.innerHTML = originalHTML;
        button.style.background = '';
        button.style.borderColor = '';
        button.style.color = '';
      }, 2000);
      
      // Show browser alert as last resort
      alert('Failed to copy text. You can manually select and copy the text.');
    }
  }
  
  // Temperature slider value display (for settings page)
  const temperatureSlider = document.getElementById('temperature');
  const temperatureValue = document.getElementById('temperatureValue');
  
  if (temperatureSlider && temperatureValue) {
    temperatureSlider.addEventListener('input', function() {
      temperatureValue.textContent = this.value;
    });
  }
  
  // Toggle custom model input field (for settings page)
  const modelSelect = document.getElementById('modelSelect');
  const customModel = document.getElementById('customModel');
  
  if (modelSelect && customModel) {
    modelSelect.addEventListener('change', function() {
      if (this.value === 'custom') {
        customModel.style.display = 'block';
        customModel.focus();
      } else {
        customModel.style.display = 'none';
        customModel.value = '';
        customModel.value = this.value;
      }
    });
  }
  
  // Add smooth scrolling for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        target.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }
    });
  });
  
  // Auto-hide alerts after 5 seconds
  document.querySelectorAll('.alert:not(.alert-persistent)').forEach(alert => {
    setTimeout(() => {
      if (alert.classList.contains('show')) {
        alert.classList.remove('show');
        alert.classList.add('fade');
        setTimeout(() => {
          alert.remove();
        }, 150);
      }
    }, 5000);
  });
});