const mongoose = require('mongoose');
const { addDays } = require('date-fns');
const PDFDocument = require('pdfkit');
const { WritableStreamBuffer } = require('stream-buffers');
const Invoice = require('../../models/Invoice');
const sendEmail = require('./../emailService');
const XeroService = require('./xeroService');

/**
 * Finds an invoice by various identifiers (ID, amount, date, or client name)
 * @param {string} userId - The user ID associated with the invoice
 * @param {string} identifier - The identifier to search by (ID, amount, date, or client name)
 * @returns {Promise<Object|null>} - The found invoice or null if not found
 */
const findInvoice = async (userId, identifier) => {
    console.log('[findInvoice] Called with:', { userId, identifier });

    if (!identifier) {
        console.log('[findInvoice] No identifier provided');
        return null;
    }

    if (mongoose.Types.ObjectId.isValid(identifier)) {
        console.log('[findInvoice] Identifier is a valid ObjectId');
        const invoice = await Invoice.findOne({ _id: identifier, user: userId });
        console.log('[findInvoice] Invoice by ID:', invoice);
        return invoice;
    }

    const amountMatch = identifier.match(/(\$?\d+(\.\d{1,2})?)/);
    if (amountMatch) {
        const amount = parseFloat(amountMatch[1].replace('$', ''));
        console.log('[findInvoice] Identifier matched amount:', amount);
        const amountInvoices = await Invoice.find({
            amount: amount,
            user: userId
        }).sort({ createdAt: -1 }).limit(5);
        console.log('[findInvoice] Invoices by amount:', amountInvoices);
        if (amountInvoices.length > 0) {
            return amountInvoices[0];
        }
    }

    const dateParsed = new Date(identifier);
    if (!isNaN(dateParsed.getTime())) {
        console.log('[findInvoice] Identifier matched date:', dateParsed);
        const dateInvoices = await Invoice.find({
            $or: [
                { date: dateParsed },
                { dueDate: dateParsed }
            ],
            user: userId
        }).sort({ createdAt: -1 }).limit(5);
        console.log('[findInvoice] Invoices by date:', dateInvoices);
        if (dateInvoices.length > 0) {
            return dateInvoices[0];
        }
    }

    console.log('[findInvoice] Fallback to clientName search');
    const nameInvoices = await Invoice.find({
        clientName: { $regex: new RegExp(identifier, 'i') },
        user: userId
    }).sort({ createdAt: -1 }).limit(5);
    console.log('[findInvoice] Invoices by clientName:', nameInvoices);

    return nameInvoices[0];
};

/**
 * Generates email content for an invoice
 * @param {Object} invoice - The invoice document
 * @param {string} emailAddress - The recipient email address
 * @returns {Object} - Email data object with text and HTML content
 */
const generateInvoiceEmail = (invoice, emailAddress) => {
    console.log('[generateInvoiceEmail] Generating email for invoice:', {
        invoiceId: invoice._id,
        clientName: invoice.clientName,
        emailAddress
    });

    const formattedDate = invoice.date.toLocaleDateString();
    const formattedDueDate = invoice.dueDate.toLocaleDateString();
    const formattedAmount = `$${invoice.amount.toFixed(2)}`;
    const statusColor = invoice.status === 'Paid' ? '#2ecc71' : invoice.status === 'Overdue' ? '#e74c3c' : '#f39c12';

    const invoiceIdentifier = invoice.invoiceNumber
        ? `#${invoice.invoiceNumber}`
        : invoice._id
            ? `(ID: ${invoice._id.toString()})`
            : '';

    const text = `
Invoice Details
---------------
Client: ${invoice.clientName}
Invoice: ${invoiceIdentifier}
Invoice Date: ${formattedDate}
Due Date: ${formattedDueDate}
Amount: ${formattedAmount}
Status: ${invoice.status}
Description: ${invoice.description || 'N/A'}
${invoice.xeroInvoiceId ? `Xero Invoice ID: ${invoice.xeroInvoiceId}` : ''}

Thank you for your business!
    `;

    const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; padding: 20px; border-radius: 5px;">
    <h2 style="color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px;">Invoice Details</h2>
    <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold; width: 30%;">Client:</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee;">${invoice.clientName}</td>
        </tr>
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Invoice:</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee;">${invoiceIdentifier}</td>
        </tr>
        ${invoice.xeroInvoiceId ? `
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Xero ID:</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee;">${invoice.xeroInvoiceId}</td>
        </tr>
        ` : ''}
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Invoice Date:</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee;">${formattedDate}</td>
        </tr>
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Due Date:</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee;">${formattedDueDate}</td>
        </tr>
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Amount:</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">${formattedAmount}</td>
        </tr>
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Status:</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; color: ${statusColor};">${invoice.status}</td>
        </tr>
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; font-weight: bold;">Description:</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee;">${invoice.description || 'N/A'}</td>
        </tr>
    </table>
   
    <p style="margin-top: 30px; font-style: italic; text-align: center; color: #7f8c8d;">
        Thank you for your business!<br>
        Please contact us if you have any questions about this invoice.
    </p>
</div>
    `;

    const emailData = {
        to: emailAddress,
        subject: `Invoice ${invoiceIdentifier} from ${invoice.clientName} - ${formattedAmount}`,
        text,
        html
    };

    console.log('[generateInvoiceEmail] Generated email data:', emailData);
    return emailData;
};

const generateInvoicePDF = async (invoice, options = {}) => {
  return new Promise((resolve, reject) => {
    try {
      if (!invoice) throw new Error('Invoice data is required');

      const config = {
        logoText: 'EveAI',
        currencySymbol: '$',
        pageSize: 'A4',
        margin: 50,
        ...options,
      };

      const doc = new PDFDocument({
        size: config.pageSize,
        margin: config.margin,
        info: {
          Title: `Invoice ${invoice.invoiceNumber || invoice._id}`,
          Author: config.logoText,
          Subject: `Invoice for ${invoice.clientName}`,
          Keywords: 'invoice, billing, payment',
        }
      });

      const buffer = new WritableStreamBuffer();
      doc.pipe(buffer);

      const formatCurrency = (amount) => {
        if (typeof amount !== 'number') return 'N/A';
        return `${config.currencySymbol}${amount.toFixed(2)}`;
      };

      const formatDate = (date) => {
        if (!date) return 'N/A';
        return new Date(date).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric'
        });
      };

      const drawLine = () => {
        doc.moveDown(0.5);
        doc.strokeColor('#000').lineWidth(0.5)
          .moveTo(config.margin, doc.y)
          .lineTo(doc.page.width - config.margin, doc.y)
          .stroke();
        doc.moveDown(1);
      };

      const checkMissing = (field, label) => {
        if (!invoice[field]) {
          missingFields.push(label);
          return `Missing ${label}`;
        }
        return invoice[field];
      };

      const missingFields = [];

      // Header
      doc.fontSize(20).font('Helvetica-Bold').text(config.logoText, config.margin);
      doc.fontSize(24).text('DRAFT', { align: 'right' });
      drawLine();

      // Invoice Info
      doc.fontSize(10).font('Helvetica-Bold').text('Invoice Number:', { continued: true })
        .font('Helvetica').text(invoice.invoiceNumber || invoice._id || 'N/A');
      doc.font('Helvetica-Bold').text('Invoice Date:', { continued: true })
        .font('Helvetica').text(formatDate(invoice.date));
      doc.font('Helvetica-Bold').text('Due Date:', { continued: true })
        .font('Helvetica').text(formatDate(invoice.dueDate));
      doc.font('Helvetica-Bold').text('Status:', { continued: true })
        .font('Helvetica').text(invoice.status || 'Pending');
      drawLine();

      // Client Info
      doc.fontSize(12).font('Helvetica-Bold').text('Bill To:');
      doc.font('Helvetica').fontSize(11).text(checkMissing('clientName', 'Client Name'));
      if (invoice.clientAddress) doc.text(invoice.clientAddress);
      if (invoice.clientEmail) doc.text(invoice.clientEmail);
      drawLine();

      // Description
      doc.fontSize(12).font('Helvetica-Bold').text('Work Summary:');
      doc.font('Helvetica').fontSize(11).text(checkMissing('description', 'Description'));
      drawLine();

      // Task Breakdown
      if (invoice.tasks && invoice.tasks.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').text('Task Breakdown:');
        doc.font('Helvetica').fontSize(11);
        invoice.tasks.forEach(task => doc.text(`• ${task}`));
        drawLine();
      }

      // Itemized Charges
      if (invoice.items && invoice.items.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').text('Itemized Charges:');
        invoice.items.forEach((item, idx) => {
          const desc = item.description || 'No description';
          const qty = item.quantity || 1;
          const unit = formatCurrency(item.unitAmount || item.amount || 0);
          const total = formatCurrency((item.unitAmount || item.amount || 0) * qty);
          doc.font('Helvetica').fontSize(11)
            .text(`${idx + 1}. ${desc} - Qty: ${qty}, Unit: ${unit}, Total: ${total}`);
        });
        drawLine();
      }

      // Taxes & Total
      const subtotal = invoice.items?.reduce(
        (sum, item) => sum + ((item.unitAmount || item.amount || 0) * (item.quantity || 1)),
        0
      ) || invoice.amount || 0;

      const taxRate = invoice.taxRate || 0;
      const taxAmount = subtotal * taxRate;
      const totalAmount = subtotal + taxAmount;

      doc.fontSize(12).font('Helvetica-Bold').text('Summary:');
      doc.font('Helvetica').fontSize(11).text(`Subtotal: ${formatCurrency(subtotal)}`);
      doc.text(`Tax (${(taxRate * 100).toFixed(1)}%): ${formatCurrency(taxAmount)}`);
      doc.font('Helvetica-Bold').text(`Total Due: ${formatCurrency(totalAmount)}`);
      drawLine();

      // Missing Data Notice
      if (missingFields.length > 0) {
        doc.moveDown();
        doc.fontSize(10).font('Helvetica-Bold').text('⚠️ Missing Data:');
        doc.font('Helvetica').fontSize(10).list(missingFields);
        drawLine();
      }

      // Footer
      doc.moveDown(3);
      doc.fontSize(10).font('Helvetica').text('Thank you for your business!', { align: 'center' });
      doc.fontSize(8).text(`Generated on ${new Date().toLocaleString()}`, { align: 'center' });

      doc.end();

      buffer.on('finish', () => {
        const pdfBuffer = buffer.getContents();
        if (!pdfBuffer || pdfBuffer.length === 0) {
          return reject(new Error('Generated PDF is empty'));
        }
        resolve(pdfBuffer);
      });

      buffer.on('error', (error) => {
        reject(new Error(`PDF buffer error: ${error.message}`));
      });

    } catch (error) {
      reject(new Error(`PDF generation error: ${error.message}`));
    }
  });
};


exports.generateInvoicePDF = generateInvoicePDF;

/**
 * Creates line items for Xero invoice from items array or single amount
 * @param {Array|Object} items - The items array or invoice amount
 * @returns {Array} - Array of Xero line items
 */
const createXeroLineItems = (items) => {
    console.log('[createXeroLineItems] Creating line items from:', items);

    if (Array.isArray(items)) {
        const lineItems = items.map(item => ({
            description: item.description || 'Product/Service',
            quantity: item.quantity || 1,
            unitAmount: item.unitAmount || item.amount || 0,
            accountCode: item.accountCode || '200',
            taxAmount: item.taxAmount || 0,
            lineAmount: item.lineAmount || (item.quantity || 1) * (item.unitAmount || item.amount || 0)
        }));
        console.log('[createXeroLineItems] Generated line items array:', lineItems);
        return lineItems;
    }

    // Fallback for single amount invoices
    const lineItem = {
        description: 'Invoice item',
        quantity: 1,
        unitAmount: items.amount || items,
        accountCode: items.accountCode || '200'
    };
    console.log('[createXeroLineItems] Generated single line item:', lineItem);
    return [lineItem];
};

/**
 * Handles all invoice-related actions
 * @param {string} userId - The user ID associated with the action
 * @param {Object} action - The action object
 * @param {Object} params - The parameters for the action
 * @returns {Promise<Object>} - The result of the action
 */
exports.handleInvoiceAction = async (userId, action, params) => {
    console.log('[handleInvoiceAction] Called with:', {
        userId,
        action: JSON.stringify(action),
        params: JSON.stringify(params)
    });

    const requiredFields = {
        'create_invoice': ['clientName', 'amount'],
        'update_invoice': ['invoiceId'],
        'mark_invoice_paid': ['invoiceId'],
        'pay_invoice': ['invoiceId'],
        'send_invoice': ['invoiceId', 'email'],
        'resend_invoice': ['invoiceId']
    };

    const actionType = action.type || action.action;
    console.log('[handleInvoiceAction] Original action type:', actionType);

    const normalizedActionType = actionType === 'pay_invoice' ? 'mark_invoice_paid' :
        actionType === 'resend_invoice' ? 'send_invoice' :
            actionType;

    console.log('[handleInvoiceAction] Normalized action type:', normalizedActionType);

    const missingFields = validateParams(requiredFields[normalizedActionType] || [], params);
    if (missingFields?.length > 0) {
        console.error('[handleInvoiceAction] Missing required fields:', missingFields);
        return {
            success: false,
            missingFields,
            error: `Missing required fields: ${missingFields.join(', ')}`
        };
    }

    let result = null;
    let emailResult = null;
    let xeroResult = null;

    try {
        switch (normalizedActionType) {
            case 'create_invoice': {
                console.log('[handleInvoiceAction] Creating invoice with params:', params);

                // Create local invoice first
                const invoiceData = {
                    clientName: params.clientName,
                    amount: params.amount,
                    description: params.description || '',
                    tasks: Array.isArray(params.tasks) ? params.tasks : [],
                    items: Array.isArray(params.items) ? params.items : [],
                    taxRate: typeof params.taxRate === 'number' ? params.taxRate : 0,
                    date: params.date ? new Date(params.date) : new Date(),
                    dueDate: params.dueDate ? new Date(params.dueDate) : addDays(new Date(), 30),
                    status: 'Pending',
                    user: userId,
                    invoiceNumber: params.invoiceNumber || null
                };

                console.log('[handleInvoiceAction] Invoice data prepared:', invoiceData);

                result = await Invoice.create(invoiceData);
                console.log('[handleInvoiceAction] Created invoice:', result);

                // Check Xero connection status
                const tenantId = XeroService.getTenantId();
                console.log('[handleInvoiceAction] Checking Xero connection. Tenant ID:', tenantId);

                // Create Xero invoice if connected
                if (tenantId) {
                    console.log('[handleInvoiceAction] Xero connected, proceeding with Xero invoice creation');
                    try {
                        const xeroInvoiceData = {
                            contactName: params.clientName,
                            lineItems: createXeroLineItems(params.items || {
                                amount: params.amount,
                                description: params.description,
                                accountCode: params.accountCode
                            }),
                            date: invoiceData.date.toISOString(),
                            dueDate: invoiceData.dueDate.toISOString(),
                            reference: params.reference || `INV-${result.invoiceNumber || result._id.toString().slice(-6)}`,
                            status: 'AUTHORISED'
                        };

                        console.log('[handleInvoiceAction] Creating Xero invoice with data:', xeroInvoiceData);
                        xeroResult = await XeroService.createInvoice(xeroInvoiceData);
                        console.log('[handleInvoiceAction] Xero invoice created successfully:', xeroResult);

                        // Update local invoice with Xero reference
                        if (xeroResult && xeroResult.invoiceID) {
                            console.log('[handleInvoiceAction] Updating local invoice with Xero details');
                            result = await Invoice.findOneAndUpdate(
                                { _id: result._id },
                                {
                                    xeroInvoiceId: xeroResult.invoiceID,
                                    xeroReference: xeroResult.reference,
                                    xeroStatus: xeroResult.status
                                },
                                { new: true }
                            );
                            console.log('[handleInvoiceAction] Local invoice updated with Xero details:', result);
                        } else {
                            console.warn('[handleInvoiceAction] Xero invoice created but no invoiceID returned');
                        }
                    } catch (xeroError) {
                        console.error('[handleInvoiceAction] Error creating Xero invoice:', {
                            message: xeroError.message,
                            stack: xeroError.stack,
                            response: xeroError.response?.data
                        });

                        // Mark invoice with sync error
                        result = await Invoice.findOneAndUpdate(
                            { _id: result._id },
                            {
                                xeroSyncError: xeroError.message || 'Failed to sync with Xero',
                                xeroSyncErrorDetails: JSON.stringify({
                                    code: xeroError.code,
                                    status: xeroError.status,
                                    response: xeroError.response?.data
                                })
                            },
                            { new: true }
                        );
                        console.log('[handleInvoiceAction] Invoice marked with Xero sync error:', result);
                    }
                } else {
                    console.log('[handleInvoiceAction] No Xero tenant ID found, skipping Xero integration');
                }

                // Handle email sending if requested
                if (params.sendEmail || params.email) {
                    const emailAddress = params.email || params.sendEmail;
                    if (emailAddress) {
                        console.log('[handleInvoiceAction] Sending email for new invoice to:', emailAddress);
                        const emailData = generateInvoiceEmail(result, emailAddress);
                        emailResult = await sendEmail(emailData);
                        console.log('[handleInvoiceAction] Email sent successfully:', emailResult);

                        result = await Invoice.findOneAndUpdate(
                            { _id: result._id },
                            {
                                lastSent: new Date(),
                                sentTo: emailAddress,
                                status: result.status === 'Draft' ? 'Pending' : result.status
                            },
                            { new: true }
                        );
                        console.log('[handleInvoiceAction] Invoice updated with email details:', result);
                    }
                }
                break;
            }

            case 'update_invoice': {
                console.log('[handleInvoiceAction] Updating invoice:', params.invoiceId);
                const invoice = await findInvoice(userId, params.invoiceId);

                if (!invoice) {
                    console.error('[handleInvoiceAction] Invoice not found or no permission:', params.invoiceId);
                    throw new Error(`Invoice not found or you don't have permission to update it`);
                }

                const updateFields = {};

                if (params.clientName) updateFields.clientName = params.clientName;
                if (params.amount) updateFields.amount = params.amount;
                if (params.description !== undefined) updateFields.description = params.description;
                if (params.date) {
                    updateFields.date = new Date(params.date);
                    if (isNaN(updateFields.date.getTime())) {
                        console.error('[handleInvoiceAction] Invalid date format:', params.date);
                        throw new Error('Invalid date format');
                    }
                }
                if (params.dueDate) {
                    updateFields.dueDate = new Date(params.dueDate);
                    if (isNaN(updateFields.dueDate.getTime())) {
                        console.error('[handleInvoiceAction] Invalid due date format:', params.dueDate);
                        throw new Error('Invalid due date format');
                    }
                }
                if (params.status) {
                    updateFields.status = ['Pending', 'Paid', 'Overdue'].includes(params.status)
                        ? params.status
                        : 'Pending';
                }
                if (params.invoiceNumber !== undefined) updateFields.invoiceNumber = params.invoiceNumber;
                if (params.items !== undefined) updateFields.items = params.items;

                console.log('[handleInvoiceAction] Updating invoice with fields:', updateFields);
                result = await Invoice.findOneAndUpdate(
                    { _id: invoice._id },
                    updateFields,
                    { new: true, runValidators: true }
                );
                console.log('[handleInvoiceAction] Invoice updated successfully:', result);

                // Check if we should sync with Xero
                if (XeroService.getTenantId() && invoice.xeroInvoiceId) {
                    console.log('[handleInvoiceAction] Xero connected and invoice has Xero ID, attempting update');
                    try {
                        const xeroUpdateData = {
                            invoiceID: invoice.xeroInvoiceId,
                            contactName: params.clientName || invoice.clientName,
                            lineItems: createXeroLineItems(params.items || invoice.items || {
                                amount: params.amount || invoice.amount,
                                description: params.description || invoice.description
                            }),
                            reference: params.reference || invoice.xeroReference || `INV-${result.invoiceNumber || result._id.toString().slice(-6)}`
                        };

                        console.log('[handleInvoiceAction] Updating Xero invoice with data:', xeroUpdateData);
                        xeroResult = await XeroService.updateInvoice(xeroUpdateData);
                        console.log('[handleInvoiceAction] Xero invoice updated successfully:', xeroResult);

                        // Update local invoice with Xero status if changed
                        if (xeroResult && xeroResult.status !== invoice.xeroStatus) {
                            result = await Invoice.findOneAndUpdate(
                                { _id: result._id },
                                { xeroStatus: xeroResult.status },
                                { new: true }
                            );
                            console.log('[handleInvoiceAction] Local invoice updated with new Xero status:', result);
                        }
                    } catch (xeroError) {
                        console.error('[handleInvoiceAction] Error updating Xero invoice:', {
                            message: xeroError.message,
                            stack: xeroError.stack,
                            response: xeroError.response?.data
                        });

                        result = await Invoice.findOneAndUpdate(
                            { _id: result._id },
                            {
                                xeroSyncError: xeroError.message || 'Failed to sync update with Xero',
                                xeroSyncErrorDetails: JSON.stringify({
                                    code: xeroError.code,
                                    status: xeroError.status,
                                    response: xeroError.response?.data
                                })
                            },
                            { new: true }
                        );
                        console.log('[handleInvoiceAction] Invoice marked with Xero sync error:', result);
                    }
                }

                if (params.sendEmail || params.email) {
                    const emailAddress = params.email || params.sendEmail;
                    if (emailAddress) {
                        console.log('[handleInvoiceAction] Sending updated invoice email to:', emailAddress);
                        const emailData = generateInvoiceEmail(result, emailAddress);
                        emailResult = await sendEmail(emailData);
                        console.log('[handleInvoiceAction] Email sent successfully:', emailResult);

                        result = await Invoice.findOneAndUpdate(
                            { _id: result._id },
                            { lastSent: new Date(), sentTo: emailAddress },
                            { new: true }
                        );
                        console.log('[handleInvoiceAction] Invoice updated with email details:', result);
                    }
                }
                break;
            }

            case 'mark_invoice_paid': {
                console.log('[handleInvoiceAction] Marking invoice as paid:', params.invoiceId);
                const invoiceToMark = await findInvoice(userId, params.invoiceId);

                if (!invoiceToMark) {
                    console.error('[handleInvoiceAction] Invoice not found or no permission:', params.invoiceId);
                    throw new Error(`Invoice not found or you don't have permission to update it`);
                }

                result = await Invoice.findOneAndUpdate(
                    { _id: invoiceToMark._id },
                    {
                        status: 'Paid',
                        paidDate: new Date(),
                        dueDate: invoiceToMark.dueDate
                    },
                    { new: true, runValidators: true }
                );
                console.log('[handleInvoiceAction] Invoice marked as paid:', result);

                // Check if we should mark as paid in Xero
                if (XeroService.getTenantId() && invoiceToMark.xeroInvoiceId) {
                    console.log('[handleInvoiceAction] Xero connected and invoice has Xero ID, attempting to mark as paid');
                    try {
                        xeroResult = await XeroService.markInvoiceAsPaid({
                            invoiceID: invoiceToMark.xeroInvoiceId,
                            amountPaid: invoiceToMark.amount,
                            paymentDate: new Date().toISOString()
                        });
                        console.log('[handleInvoiceAction] Xero invoice marked as paid successfully:', xeroResult);

                        // Update local invoice with Xero payment details
                        if (xeroResult && xeroResult.status === 'PAID') {
                            result = await Invoice.findOneAndUpdate(
                                { _id: result._id },
                                { xeroStatus: xeroResult.status },
                                { new: true }
                            );
                            console.log('[handleInvoiceAction] Local invoice updated with Xero payment status:', result);
                        }
                    } catch (xeroError) {
                        console.error('[handleInvoiceAction] Error marking Xero invoice as paid:', {
                            message: xeroError.message,
                            stack: xeroError.stack,
                            response: xeroError.response?.data
                        });

                        result = await Invoice.findOneAndUpdate(
                            { _id: result._id },
                            {
                                xeroSyncError: xeroError.message || 'Failed to sync payment with Xero',
                                xeroSyncErrorDetails: JSON.stringify({
                                    code: xeroError.code,
                                    status: xeroError.status,
                                    response: xeroError.response?.data
                                })
                            },
                            { new: true }
                        );
                        console.log('[handleInvoiceAction] Invoice marked with Xero payment sync error:', result);
                    }
                }

                if (params.sendEmail || params.email) {
                    const emailAddress = params.email || params.sendEmail;
                    if (emailAddress) {
                        console.log('[handleInvoiceAction] Sending payment confirmation email to:', emailAddress);
                        const emailData = {
                            to: emailAddress,
                            subject: `Payment Received for Invoice ${result.invoiceNumber ? `#${result.invoiceNumber}` : ''}`,
                            text: `We've received your payment of $${result.amount.toFixed(2)} for invoice ${result.invoiceNumber ? `#${result.invoiceNumber}` : ''}. Thank you!`,
                            html: `
                                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                                    <h2 style="color: #2ecc71;">Payment Received</h2>
                                    <p>We've received your payment of <strong>$${result.amount.toFixed(2)}</strong> for invoice ${result.invoiceNumber ? `<strong>#${result.invoiceNumber}</strong>` : ''}.</p>
                                    <p>Thank you for your business!</p>
                                </div>
                            `
                        };
                        emailResult = await sendEmail(emailData);
                        console.log('[handleInvoiceAction] Payment confirmation email sent successfully:', emailResult);
                    }
                }
                break;
            }

            case 'send_invoice': {
                console.log('[handleInvoiceAction] Sending invoice via email:', params.invoiceId);
                const invoiceToSend = await findInvoice(userId, params.invoiceId);

                if (!invoiceToSend) {
                    console.error('[handleInvoiceAction] Invoice not found or no permission:', params.invoiceId);
                    throw new Error(`Invoice not found or you don't have permission to access it`);
                }

                try {
                    console.log('[handleInvoiceAction] Generating email for invoice:', invoiceToSend._id);
                    const emailData = generateInvoiceEmail(invoiceToSend, params.email);
                    const pdfBuffer = await generateInvoicePDF(invoiceToSend);

                    emailData.attachments = [{
                        filename: `invoice-${invoiceToSend.invoiceNumber || invoiceToSend._id}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf'
                    }];

                    console.log('[handleInvoiceAction] Sending email with attachment:', emailData);
                    emailResult = await sendEmail(emailData);

                    console.log('[handleInvoiceAction] Email sent successfully:', emailResult);

                    result = await Invoice.findOneAndUpdate(
                        { _id: invoiceToSend._id },
                        {
                            lastSent: new Date(),
                            sentTo: params.email,
                            status: invoiceToSend.status === 'Draft' ? 'Pending' : invoiceToSend.status
                        },
                        { new: true }
                    );
                    console.log('[handleInvoiceAction] Invoice updated with email details:', result);
                } catch (emailError) {
                    console.error('[handleInvoiceAction] Error sending invoice email:', {
                        message: emailError.message,
                        stack: emailError.stack,
                        response: emailError.response?.data
                    });
                    throw new Error('Failed to send invoice email');
                }
                break;
            }

            default:
                console.error('[handleInvoiceAction] Unknown action type:', actionType);
                throw new Error(`Unknown action type: ${actionType}`);
        }

        const response = {
            success: true,
            data: result,
            ...(emailResult && { emailStatus: emailResult }),
            ...(xeroResult && { xeroInvoice: xeroResult })
        };

        console.log('[handleInvoiceAction] Action completed successfully with response:', response);
        return response;
    } catch (error) {
        console.error('[handleInvoiceAction] Error processing action:', {
            actionType: normalizedActionType,
            error: {
                message: error.message,
                stack: error.stack,
                ...(error.response && { response: error.response.data })
            },
            params
        });
        throw error;
    }
};

/**
 * Validates that all required parameters are provided
 * @param {Array} requiredFields - Array of required field names
 * @param {Object} providedParams - The provided parameters
 * @returns {Array|null} - Array of missing fields or null if all are present
 */
function validateParams(requiredFields, providedParams) {
    console.log('[validateParams] Validating fields:', {
        requiredFields,
        providedParams: JSON.stringify(providedParams)
    });

    if (!requiredFields || requiredFields.length === 0) {
        console.log('[validateParams] No required fields to validate');
        return null;
    }

    const missingFields = requiredFields.filter(field => {
        const isMissing = providedParams[field] === undefined ||
            providedParams[field] === null ||
            (typeof providedParams[field] === 'string' && providedParams[field].trim() === '');
        if (isMissing) {
            console.log(`[validateParams] Missing required field: ${field}`);
        }
        return isMissing;
    });

    if (missingFields.length > 0) {
        console.log('[validateParams] Missing fields detected:', missingFields);
        return missingFields;
    }

    console.log('[validateParams] All required fields present');
    return null;
}