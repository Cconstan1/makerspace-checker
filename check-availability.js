const puppeteer = require('puppeteer');

// Helper function to wait/delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkAvailability() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        
        console.log('Loading makerspace page...');
        await page.goto('https://libcal.jocolibrary.org/reserve/makerspace', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Capture browser console logs
        page.on('console', msg => {
            console.log('BROWSER:', msg.text());
        });
        
        // Wait for the calendar to load
        await page.waitForSelector('table', { timeout: 10000 });
        await delay(3000); // Extra wait for dynamic content
        
        // Take a screenshot to see what we're working with
        await page.screenshot({ path: 'calendar-page1.png', fullPage: true });
        console.log('Screenshot saved to calendar-page1.png');
        
        console.log('Starting to check all pages...');
        
        const allAvailableDates = [];
        let pageNumber = 1;
        
        while (true) {
            console.log(`Checking page ${pageNumber}...`);
            
            // Extract availability from current page
            const availableDates = await page.evaluate(() => {
                const results = [];
                
                console.log('=== Starting page evaluation ===');
                
                // This calendar uses a list-style layout, not a traditional table
                // Find all equipment rows - they have "info" class with equipment names
                const equipmentRows = document.querySelectorAll('div.s-lc-eq-row');
                console.log(`Found ${equipmentRows.length} equipment rows`);
                
                if (equipmentRows.length === 0) {
                    // Try alternative selector
                    console.log('Trying alternative selector for equipment rows...');
                    const allRows = document.querySelectorAll('[class*="s-lc"]');
                    console.log(`Found ${allRows.length} rows with s-lc class`);
                }
                
                // Let's try a simpler approach - find all links with equipment names
                const equipmentLinks = document.querySelectorAll('a[href*="reserve"]');
                console.log(`Found ${equipmentLinks.length} equipment links`);
                
                for (const link of equipmentLinks) {
                    const equipmentName = link.textContent.trim();
                    console.log(`Checking equipment: ${equipmentName}`);
                    
                    // Check if this is one of our target equipment
                    const isTargetEquipment = equipmentName.includes('Apple Mac Studio w/ Epson 12000XL 2D Scanner') || 
                                             equipmentName.includes('Vinyl Cutter & Heat Press w/PC');
                    
                    if (isTargetEquipment) {
                        console.log(`✓ Found target equipment: ${equipmentName}`);
                        
                        // Find the parent row/container for this equipment
                        let row = link.closest('tr, div[class*="row"]');
                        if (!row) {
                            console.log('  Could not find parent row');
                            continue;
                        }
                        
                        // Find all time slot cells in this row
                        const cells = row.querySelectorAll('td, div[class*="cell"]');
                        console.log(`  Found ${cells.length} cells in row`);
                        
                        // Search backwards from the end to find the last bookable slot
                        for (let i = cells.length - 1; i >= 0; i--) {
                            const cell = cells[i];
                            const cellLink = cell.querySelector('a[href*="reserve"]');
                            
                            if (cellLink) {
                                // This is a bookable slot
                                console.log(`  Found bookable slot at cell ${i}`);
                                
                                // Check if it's available (not reserved/unavailable)
                                const isAvailable = cell.classList.contains('s-lc-eq-checkout-available') ||
                                                   cell.querySelector('.s-lc-eq-available') ||
                                                   (!cell.classList.contains('s-lc-eq-checkout-reserved') &&
                                                    !cell.classList.contains('s-lc-eq-checkout-unavailable') &&
                                                    !cell.classList.contains('s-lc-eq-checkout-disabled') &&
                                                    !cellLink.classList.contains('disabled'));
                                
                                console.log(`  Cell ${i} available: ${isAvailable}`);
                                console.log(`  Cell classes: ${cell.className}`);
                                
                                if (isAvailable) {
                                    // Try to get date/time info
                                    let dateInfo = 'Unknown';
                                    const dataDate = cell.getAttribute('data-date');
                                    const dataTime = cell.getAttribute('data-time');
                                    
                                    if (dataDate) dateInfo = dataDate;
                                    if (dataTime) dateInfo += ' ' + dataTime;
                                    
                                    results.push({
                                        equipment: equipmentName,
                                        date: dateInfo,
                                        cellIndex: i
                                    });
                                }
                                
                                // Only check the last bookable slot
                                break;
                            }
                        }
                    }
                }
                
                console.log(`=== Page evaluation complete. Found ${results.length} available slots ===`);
                return results;
            });
            
            console.log(`Page ${pageNumber} found:`, availableDates);
            allAvailableDates.push(...availableDates);
            
            // Check if next button is disabled (this is the real indicator we're at the end)
            const nextButtonDisabled = await page.evaluate(() => {
                const nextBtn = document.querySelector('button.fc-next-button');
                return nextBtn ? nextBtn.disabled : true;
            });
            
            if (nextButtonDisabled) {
                console.log('Next button is disabled - reached end of calendar');
                break;
            }
            
            // Try to click the next button
            try {
                await page.waitForSelector('button.fc-next-button', { timeout: 5000 });
                await page.click('button.fc-next-button');
                console.log('Clicked next button');
                await delay(3000); // Wait for new data to load
                pageNumber++;
            } catch (error) {
                console.log('Could not click next button:', error.message);
                break;
            }
            
            // Safety limit
            if (pageNumber > 10) {
                console.log('Reached safety limit of 10 pages');
                break;
            }
        }
        
        console.log('Total available dates found:', allAvailableDates);
        
        // Format results
        let message;
        if (allAvailableDates.length === 0) {
            message = `
🖨️ 3D PRINTER AVAILABILITY CHECK
================================

❌ None available

No available overnight printing slots (last hour of the day) found for "3D Printer - Prusa XL 5-Toolhead" over the next 14 days.

Check again tomorrow or visit: https://libcal.jocolibrary.org/reserve/makerspace
            `.trim();
        } else {
            const dateList = allAvailableDates
                .map(item => `${item.date}${item.time ? ' at ' + item.time : ''}`)
                .join('\n  • ');
            
            message = `
🖨️ 3D PRINTER AVAILABILITY CHECK
================================

✅ Available overnight printing slots (last hour):

  • ${dateList}

Book now at: https://libcal.jocolibrary.org/reserve/makerspace
            `.trim();
        }
        
        console.log('\n' + message);
        
        // Write to GitHub Actions summary
        const fs = require('fs');
        let summary;
        
        if (allAvailableDates.length > 0) {
            const dateLines = allAvailableDates
                .map(item => `- **${item.date}**${item.time ? ' at ' + item.time : ''}`)
                .join('\n');
            
            summary = `# 3D Printer Overnight Availability\n\n## ✅ Available Dates\n\n${dateLines}\n\n[Visit Booking Page](https://libcal.jocolibrary.org/reserve/makerspace)`;
        } else {
            summary = `# 3D Printer Overnight Availability\n\n## ❌ None Available\n\nNo overnight printing slots found for the next 14 days.\n\n[Visit Booking Page](https://libcal.jocolibrary.org/reserve/makerspace)`;
        }
        
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || 'summary.md', summary);
        
        return { success: true, availableDates: allAvailableDates, message };
        
    } catch (error) {
        console.error('Error checking availability:', error);
        try {
            await page.screenshot({ path: 'error.png', fullPage: true });
            console.log('Error screenshot saved');
        } catch (screenshotError) {
            console.error('Could not take screenshot:', screenshotError);
        }
        throw error;
    } finally {
        await browser.close();
    }
}

checkAvailability().catch(error => {
    console.error('Failed:', error);
    process.exit(1);
});
