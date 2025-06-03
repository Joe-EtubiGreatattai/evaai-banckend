const mongoose = require('mongoose');
const { addDays } = require('date-fns');
const Invoice = require('../../models/Invoice');
const sendEmail = require('./../emailService');

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
    
    // If it's a valid MongoDB ID, search by ID first
    if (mongoose.Types.ObjectId.isValid(identifier)) {
        console.log('[findInvoice] Identifier is a valid ObjectId');
        const invoice = await Invoice.findOne({ _id: identifier, user: userId });
        console.log('[findInvoice] Invoice by ID:', invoice);
        return invoice;
    }
    
    // Try to parse as amount (e.g., "$100" or "100")
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
    
    // Try to parse as date (e.g., "May 20", "05/20/2023")
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
    
    // Search by client name (case insensitive, partial match) as fallback
    console.log('[findInvoice] Fallback to clientName search');
    const nameInvoices = await Invoice.find({ 
        clientName: { $regex: new RegExp(identifier, 'i') },
        user: userId 
    }).sort({ createdAt: -1 }).limit(5);
    console.log('[findInvoice] Invoices by clientName:', nameInvoices);
    
    return nameInvoices[0]; // Return the most recent match
};

/**
 * Generates email content for an invoice
 * @param {Object} invoice - The invoice document
 * @param {string} emailAddress - The recipient email address
 * @returns {Object} - Email data object with text and HTML content
 */
const generateInvoiceEmail = (invoice, emailAddress) => {
    const formattedDate = invoice.date.toLocaleDateString();
    const formattedDueDate = invoice.dueDate.toLocaleDateString();
    const formattedAmount = `$${invoice.amount.toFixed(2)}`;
    const statusColor = invoice.status === 'Paid' ? '#2ecc71' : invoice.status === 'Overdue' ? '#e74c3c' : '#f39c12';

    // Get the most appropriate identifier for the invoice
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

    return {
        to: emailAddress,
        subject: `Invoice ${invoiceIdentifier} from ${invoice.clientName} - ${formattedAmount}`,
        text,
        html
    };
};

/**
 * Handles all invoice-related actions
 * @param {string} userId - The user ID associated with the action
 * @param {Object} action - The action object
 * @param {Object} params - The parameters for the action
 * @returns {Promise<Object>} - The result of the action
 */
exports.handleInvoiceAction = async (userId, action, params) => {
    console.log('[handleInvoiceAction] Called with:', { userId, action, params });

    const requiredFields = {
        'create_invoice': ['clientName', 'amount'],
        'update_invoice': ['invoiceId'],
        'mark_invoice_paid': ['invoiceId'],
        'pay_invoice': ['invoiceId'],
        'send_invoice': ['invoiceId', 'email'],
        'resend_invoice': ['invoiceId']
    };
    
    // Normalize action type to handle alternative action names
    const actionType = action.type || action.action;
    const normalizedActionType = actionType === 'pay_invoice' ? 'mark_invoice_paid' : 
                               actionType === 'resend_invoice' ? 'send_invoice' : 
                               actionType;
    
    const missingFields = validateParams(requiredFields[normalizedActionType] || [], params);
    if (missingFields?.length > 0) {
        console.log('[handleInvoiceAction] Missing required fields:', missingFields);
        return {
            success: false,
            missingFields,
            error: `Missing required fields: ${missingFields.join(', ')}`
        };
    }
    
    let result = null;
    let emailResult = null;
    
    try {
        switch (normalizedActionType) {
            case 'create_invoice':
                console.log('[handleInvoiceAction] Creating invoice with:', params);
                result = await Invoice.create({
                    clientName: params.clientName,
                    amount: params.amount,
                    description: params.description || '',
                    date: params.date ? new Date(params.date) : new Date(),
                    dueDate: params.dueDate ? new Date(params.dueDate) : addDays(new Date(), 30),
                    status: 'Pending',
                    user: userId,
                    invoiceNumber: params.invoiceNumber || null,
                    items: params.items || []
                });
                console.log('[handleInvoiceAction] Created invoice:', result);
                
                // Optionally send email on creation if sendEmail flag is true
                if (params.sendEmail && params.email) {
                    console.log('[handleInvoiceAction] Sending email for new invoice');
                    const emailData = generateInvoiceEmail(result, params.email);
                    emailResult = await sendEmail(emailData);
                    console.log('[handleInvoiceAction] Email sent successfully:', emailResult);
                    
                    // Update the invoice to track that it was sent
                    result = await Invoice.findOneAndUpdate(
                        { _id: result._id },
                        { lastSent: new Date(), sentTo: params.email },
                        { new: true }
                    );
                }
                break;
            
            case 'update_invoice':
                console.log('[handleInvoiceAction] Updating invoice:', params.invoiceId);
                const invoice = await findInvoice(userId, params.invoiceId);
                console.log('[handleInvoiceAction] Invoice found for update:', invoice);
                
                if (!invoice) {
                    console.log('[handleInvoiceAction] Invoice not found or no permission');
                    throw new Error(`Invoice not found or you don't have permission to update it`);
                }
                
                const updateFields = {};
                
                if (params.clientName) updateFields.clientName = params.clientName;
                if (params.amount) updateFields.amount = params.amount;
                if (params.description !== undefined) updateFields.description = params.description;
                if (params.date) {
                    updateFields.date = new Date(params.date);
                    if (isNaN(updateFields.date.getTime())) {
                        throw new Error('Invalid date format');
                    }
                }
                if (params.dueDate) {
                    updateFields.dueDate = new Date(params.dueDate);
                    if (isNaN(updateFields.dueDate.getTime())) {
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
                
                console.log('[handleInvoiceAction] Update fields:', updateFields);
                result = await Invoice.findOneAndUpdate(
                    { _id: invoice._id },
                    updateFields,
                    { new: true, runValidators: true }
                );
                console.log('[handleInvoiceAction] Updated invoice:', result);
                
                // Optionally send email after update if requested
                if (params.sendEmail && params.email) {
                    console.log('[handleInvoiceAction] Sending email for updated invoice');
                    const emailData = generateInvoiceEmail(result, params.email);
                    emailResult = await sendEmail(emailData);
                    console.log('[handleInvoiceAction] Email sent successfully:', emailResult);
                    
                    // Update the invoice to track that it was sent
                    result = await Invoice.findOneAndUpdate(
                        { _id: result._id },
                        { lastSent: new Date(), sentTo: params.email },
                        { new: true }
                    );
                }
                break;

            case 'mark_invoice_paid':
                console.log('[handleInvoiceAction] Marking invoice as paid:', params.invoiceId);
                const invoiceToMark = await findInvoice(userId, params.invoiceId);
                console.log('[handleInvoiceAction] Invoice found for marking paid:', invoiceToMark);
                
                if (!invoiceToMark) {
                    console.log('[handleInvoiceAction] Invoice not found or no permission');
                    throw new Error(`Invoice not found or you don't have permission to update it`);
                }
                
                result = await Invoice.findOneAndUpdate(
                    { _id: invoiceToMark._id },
                    { 
                        status: 'Paid', 
                        paidDate: new Date(),
                        dueDate: invoiceToMark.dueDate // Ensure dueDate is preserved
                    },
                    { new: true, runValidators: true }
                );
                console.log('[handleInvoiceAction] Invoice marked as paid:', result);
                
                // Optionally send confirmation email if requested
                if (params.sendEmail && params.email) {
                    console.log('[handleInvoiceAction] Sending payment confirmation email');
                    const emailData = {
                        to: params.email,
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
                    console.log('[handleInvoiceAction] Payment confirmation email sent:', emailResult);
                }
                break;
                
            case 'send_invoice':
                console.log('[handleInvoiceAction] Sending invoice via email:', params.invoiceId);
                const invoiceToSend = await findInvoice(userId, params.invoiceId);
                console.log('[handleInvoiceAction] Invoice found for sending:', invoiceToSend);
                
                if (!invoiceToSend) {
                    console.log('[handleInvoiceAction] Invoice not found or no permission');
                    throw new Error(`Invoice not found or you don't have permission to access it`);
                }
                
                try {
                    const emailData = generateInvoiceEmail(invoiceToSend, params.email);
                    emailResult = await sendEmail(emailData);
                    console.log('[handleInvoiceAction] Email sent successfully:', emailResult);
                    
                    // Update the invoice to track that it was sent
                    result = await Invoice.findOneAndUpdate(
                        { _id: invoiceToSend._id },
                        { 
                            lastSent: new Date(), 
                            sentTo: params.email,
                            status: invoiceToSend.status === 'Draft' ? 'Pending' : invoiceToSend.status
                        },
                        { new: true }
                    );
                } catch (emailError) {
                    console.error('[handleInvoiceAction] Error sending invoice email:', emailError);
                    throw new Error('Failed to send invoice email');
                }
                break;
                
            default:
                console.log('[handleInvoiceAction] Unknown action type:', actionType);
                throw new Error(`Unknown action type: ${actionType}`);
        }
        
        console.log('[handleInvoiceAction] Returning result:', result);
        return {
            success: true,
            data: result,
            ...(emailResult && { emailStatus: emailResult })
        };
    } catch (error) {
        console.error('[handleInvoiceAction] Error:', error);
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
    if (!requiredFields || requiredFields.length === 0) return null;
    
    const missingFields = requiredFields.filter(field => {
        // Check if field is missing or empty string (but allow false and 0)
        return providedParams[field] === undefined || 
               providedParams[field] === null || 
               (typeof providedParams[field] === 'string' && providedParams[field].trim() === '');
    });
    
    if (missingFields.length > 0) {
        console.log('[validateParams] Missing fields:', missingFields);
        return missingFields;
    }
    return null;
}