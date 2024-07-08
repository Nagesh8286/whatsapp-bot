const venom = require('venom-bot');
const { google } = require('googleapis');
const axios = require('axios');
const mime = require('mime-types');
const fs = require('fs-extra');
const path = require('path');

// Google Sheets setup
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'];
const KEYFILEPATH = '/etc/secrets/google-credentials.json'; // Update this path
const SPREADSHEET_ID = '1y-HyJJupGYOPU3YbtCcS2hITlLF8jFCgV42_SqP0H-o';

let authClient;
let googleSheets;

const initGoogleAPI = async () => {
  if (!authClient) {
    authClient = new google.auth.GoogleAuth({
      keyFile: KEYFILEPATH,
      scopes: SCOPES,
    });
    const client = await authClient.getClient();
    googleSheets = google.sheets({ version: 'v4', auth: client });
  }
};

let currentDesignRequest = {};
let currentInvoiceRequest = {};
let pendingNumberRequest = {};

const fetchSheetData = async (sheetName, range) => {
  await initGoogleAPI();
  try {
    const response = await googleSheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!${range}`,
    });
    return response.data.values || [];
  } catch (error) {
    console.error(`Error fetching data from Google Sheets (${sheetName}):`, error);
    return [];
  }
};

const getFileLinksAndCheckNumber = async (id, senderNumber) => {
  const rows = await fetchSheetData('Sheet1', 'A:D');
  let senderRegistered = false;
  let fileLinks = [];
  let colors = [];

  for (const row of rows) {
    const registeredNumbers = row[2] ? row[2].split(',').map(num => num.trim()) : [];
    if (registeredNumbers.includes(senderNumber)) {
      senderRegistered = true;
      if (row[0] == id) {
        const fileId = row[1].match(/\/d\/(.*?)\//)[1];
        const fileLink = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        fileLinks.push(fileLink);
        colors.push(row[3]);
      }
    }
  }
  return { links: fileLinks, senderRegistered, colors };
};

const getInvoiceFileAndCheckNumber = async (invoiceNumber, senderNumber, columnIndex) => {
  const rows = await fetchSheetData('Invoice', 'A:H');
  let senderRegistered = false;
  let fileLink = '';

  for (const row of rows) {
    const registeredNumbers = row[7] ? row[7].split(',').map(num => num.trim()) : [];
    if (registeredNumbers.includes(senderNumber)) {
      senderRegistered = true;
      if (row[0] == invoiceNumber) {
        const fileId = row[columnIndex].match(/\/d\/(.*?)\//)[1];
        fileLink = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      }
    }
  }
  return { link: fileLink, senderRegistered };
};

const getLRImageAndCheckNumber = async (lrNumber, senderNumber) => {
  const rows = await fetchSheetData('Invoice', 'A:H');
  let senderRegistered = false;
  let fileLink = '';

  for (const row of rows) {
    const registeredNumbers = row[7] ? row[7].split(',').map(num => num.trim()) : [];
    if (registeredNumbers.includes(senderNumber)) {
      senderRegistered = true;
      if (row[1] == lrNumber) {
        const fileId = row[5].match(/\/d\/(.*?)\//)[1];
        fileLink = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      }
    }
  }
  return { link: fileLink, senderRegistered };
};

venom
  .create({
    session: 'sessionName', // Pass your session name here
    headless: true, // Open the browser in headless mode
    devtools: false, // Open the browser with devtools
    useChrome: true, // If false will use Chromium instance
    debug: false, // Opens a debug session
    puppeteerOptions: {
      protocolTimeout: 120000, // Increase the protocol timeout to 120 seconds (120000 ms)
    },
  })
  .then((client) => start(client))
  .catch((error) => console.log(error));

function start(client) {
  client.onMessage(async (message) => {
    console.log(`Received message: ${message.body}`);

    if (!message.isGroupMsg) {
      const senderNumber = message.from.split('@')[0];

      if (message.type === 'chat') {
        if (message.body.toLowerCase() === 'hi' || message.body.toLowerCase() === 'hello') {
          client.sendText(message.from, 'Hello! How can I help you today?\n\nType 1 for Design Image\nType 2 for Invoice\nType 3 for PT File\nType 4 for LR Image');
        } else if (message.body === '1') {
          client.sendText(message.from, 'Please enter the design number:');
          currentDesignRequest[senderNumber] = { step: 'waiting_for_design_number' };
        } else if (message.body === '2') {
          client.sendText(message.from, 'Please enter the invoice number:');
          currentInvoiceRequest[senderNumber] = { type: 'invoice', columnIndex: 3 };
        } else if (message.body === '3') {
          client.sendText(message.from, 'Please enter the invoice number for the PT file:');
          currentInvoiceRequest[senderNumber] = { type: 'pt', columnIndex: 4 };
        } else if (message.body === '4') {
          client.sendText(message.from, 'Please enter the LR number (case-sensitive):');
          currentInvoiceRequest[senderNumber] = { type: 'lr' };
        } else if (!isNaN(message.body) || typeof message.body === 'string') {
          const inputNumber = message.body;
          if (currentDesignRequest[senderNumber] && currentDesignRequest[senderNumber].step === 'waiting_for_design_number') {
            const designNumber = inputNumber;
            currentDesignRequest[senderNumber].designNumber = designNumber;
            const result = await getFileLinksAndCheckNumber(designNumber, senderNumber);
            console.log(`File links for Design No ${designNumber}: ${result.links}`);

            if (result.senderRegistered) {
              if (result.links.length > 0) {
                const uniqueColors = [...new Set(result.colors)];
                if (uniqueColors.length > 1) {
                  let colorOptions = 'Please select a color:\n\n';
                  uniqueColors.forEach((color, index) => {
                    colorOptions += `• Type ${String.fromCharCode(97 + index)} for ${color}\n`;
                  });
                  currentDesignRequest[senderNumber].colors = uniqueColors;
                  currentDesignRequest[senderNumber].step = 'waiting_for_color';
                  client.sendText(message.from, colorOptions);
                } else {
                  await sendFile(client, message.from, result.links[0]);
                  delete currentDesignRequest[senderNumber];
                }
              } else {
                client.sendText(message.from, 'Sorry, no file found for the given design number.');
                delete currentDesignRequest[senderNumber];
              }
            } else {
              client.sendText(message.from, 'Sorry, your number is not registered.');
              delete currentDesignRequest[senderNumber];
            }
          } else if (currentDesignRequest[senderNumber] && currentDesignRequest[senderNumber].step === 'waiting_for_color') {
            const colorIndex = message.body.toLowerCase().charCodeAt(0) - 97;
            const selectedColor = currentDesignRequest[senderNumber].colors[colorIndex];
            if (selectedColor) {
              const designNumber = currentDesignRequest[senderNumber].designNumber;
              const result = await getFileLinksAndCheckNumber(designNumber, senderNumber);
              const selectedLinks = result.links.filter((_, index) => result.colors[index] === selectedColor);
              if (selectedLinks.length > 0) {
                await sendFilesInParallel(client, message.from, selectedLinks);
              } else {
                client.sendText(message.from, 'Sorry, no file found for the selected color.');
              }
              delete currentDesignRequest[senderNumber];
            } else {
              client.sendText(message.from, 'Invalid color selection. Please try again.');
            }
          } else if (currentInvoiceRequest[senderNumber]) {
            if (currentInvoiceRequest[senderNumber].type === 'invoice' || currentInvoiceRequest[senderNumber].type === 'pt') {
              const columnIndex = currentInvoiceRequest[senderNumber].columnIndex;
              const result = await getInvoiceFileAndCheckNumber(inputNumber, senderNumber, columnIndex);
              console.log(`File link for ${currentInvoiceRequest[senderNumber].type.toUpperCase()} No ${inputNumber}: ${result.link}`);

              if (result.senderRegistered) {
                if (result.link) {
                  await sendFile(client, message.from, result.link);
                } else {
                  client.sendText(message.from, `Sorry, no file found for the given ${currentInvoiceRequest[senderNumber].type.toUpperCase()} number.`);
                }
              } else {
                client.sendText(message.from, 'Sorry, your number is not registered.');
              }
              delete currentInvoiceRequest[senderNumber];
            } else if (currentInvoiceRequest[senderNumber].type === 'lr') {
              const result = await getLRImageAndCheckNumber(inputNumber, senderNumber);
              console.log(`File link for LR No ${inputNumber}: ${result.link}`);

              if (result.senderRegistered) {
                if (result.link) {
                  await sendFile(client, message.from, result.link);
                } else {
                  client.sendText(message.from, 'Sorry, no file found for the given LR number.');
                }
              } else {
                client.sendText(message.from, 'Sorry, your number is not registered.');
              }
              delete currentInvoiceRequest[senderNumber];
            }
          } else {
            client.sendText(message.from, 'Please specify the type of request:\nType 1 for Design Image\nType 2 for Invoice\nType 3 for PT File\nType 4 for LR Image');
            pendingNumberRequest[senderNumber] = inputNumber;
          }
        } else if (message.body === '1' || message.body === '2' || message.body === '3' || message.body === '4') {
          const type = message.body;
          if (pendingNumberRequest[senderNumber]) {
            const inputNumber = pendingNumberRequest[senderNumber];
            delete pendingNumberRequest[senderNumber];

            if (type === '1') {
              const result = await getFileLinksAndCheckNumber(inputNumber, senderNumber);
              console.log(`File links for Design No ${inputNumber}: ${result.links}`);

              if (result.senderRegistered) {
                if (result.links.length > 0) {
                  const uniqueColors = [...new Set(result.colors)];
                  if (uniqueColors.length > 1) {
                    let colorOptions = 'Please select a color:\n\n';
                    uniqueColors.forEach((color, index) => {
                      colorOptions += `• Type ${String.fromCharCode(97 + index)} for ${color}\n`;
                    });
                    currentDesignRequest[senderNumber] = { designNumber: inputNumber, colors: uniqueColors };
                    client.sendText(message.from, colorOptions);
                  } else {
                    await sendFile(client, message.from, result.links[0]);
                  }
                } else {
                  client.sendText(message.from, 'Sorry, no file found for the given design number.');
                }
              } else {
                client.sendText(message.from, 'Sorry, your number is not registered.');
              }
            } else if (type === '2') {
              const result = await getInvoiceFileAndCheckNumber(inputNumber, senderNumber, 3);
              console.log(`File link for Invoice No ${inputNumber}: ${result.link}`);

              if (result.senderRegistered) {
                if (result.link) {
                  await sendFile(client, message.from, result.link);
                } else {
                  client.sendText(message.from, 'Sorry, no file found for the given invoice number.');
                }
              } else {
                client.sendText(message.from, 'Sorry, your number is not registered.');
              }
            } else if (type === '3') {
              const result = await getInvoiceFileAndCheckNumber(inputNumber, senderNumber, 4);
              console.log(`File link for PT File No ${inputNumber}: ${result.link}`);

              if (result.senderRegistered) {
                if (result.link) {
                  await sendFile(client, message.from, result.link);
                } else {
                  client.sendText(message.from, 'Sorry, no file found for the given PT file number.');
                }
              } else {
                client.sendText(message.from, 'Sorry, your number is not registered.');
              }
            } else if (type === '4') {
              const result = await getLRImageAndCheckNumber(inputNumber, senderNumber);
              console.log(`File link for LR No ${inputNumber}: ${result.link}`);

              if (result.senderRegistered) {
                if (result.link) {
                  await sendFile(client, message.from, result.link);
                } else {
                  client.sendText(message.from, 'Sorry, no file found for the given LR number.');
                }
              } else {
                client.sendText(message.from, 'Sorry, your number is not registered.');
              }
            }
          } else {
            client.sendText(message.from, 'Sorry, I did not understand that. Please type "1" to request a design image, "2" to request an invoice, "3" to request a PT file, or "4" to request an LR image.');
          }
        } else {
          client.sendText(message.from, 'Sorry, I did not understand that. Please type "1" to request a design image, "2" to request an invoice, "3" to request a PT file, or "4" to request an LR image.');
        }
      }
    }
  });
}

async function sendFilesInParallel(client, to, links) {
  try {
    const googleAuthClient = await authClient.getClient();
    const token = await googleAuthClient.getAccessToken();

    const filePromises = links.map(async (link) => {
      const response = await axios({
        url: link,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${token.token}` },
      });

      const buffer = Buffer.from(response.data);
      const type = mime.extension(response.headers['content-type']);
      const fileExtension = type ? type : 'bin';
      const fileName = `download.${fileExtension}`;
      fs.writeFileSync(fileName, buffer);

      console.log(`File downloaded successfully: ${fileName}`);

      if (fileExtension === 'pdf') {
        await client.sendFile(to, path.resolve(fileName), fileName, 'Here is your requested PDF.');
      } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'xls', 'xlsx'].includes(fileExtension)) {
        await client.sendFile(to, path.resolve(fileName), fileName, 'Here is your requested file.');
      } else {
        await client.sendText(to, 'Sorry, the file format is not supported.');
      }

      fs.unlinkSync(fileName);
    });

    await Promise.all(filePromises);
  } catch (error) {
    console.error('Error when downloading the file:', error);
    client.sendText(to, 'Sorry, there was an error downloading the file.');
  }
}

async function sendFile(client, to, link) {
  await sendFilesInParallel(client, to, [link]);
}
