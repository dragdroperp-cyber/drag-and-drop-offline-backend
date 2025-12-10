const mongoose = require("mongoose");
const OrderSchema = new mongoose.Schema({
    sellerId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Seller",
        required:true
    },
    customerId:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"Customer"
    },
    customerName:{
        type:String,
        default:''
    },
    customerMobile:{
        type:String,
        default:''
    },
    paymentMethod:{
        type:String,
        enum:["cash","card","upi","due","credit","split"],
        required:true,
        default:"cash"
    },
    splitPaymentDetails:{
        type: {
            type: String,
            default: null,
            validate: {
                validator: function(value) {
                    // Allow null/undefined values - they will be handled by pre-save hook
                    if (value === null || value === undefined) {
                        return true;
                    }
                    // Validate enum values
                    return ["cash_online", "online_due", "cash_due"].includes(value);
                },
                message: 'Type must be one of: cash_online, online_due, cash_due'
            }
        },
        cashAmount: {
            type: Number,
            default: 0
        },
        onlineAmount: {
            type: Number,
            default: 0
        },
        dueAmount: {
            type: Number,
            default: 0
        },
        _id: false
    },
    items:[
        {
            productId:{
                type:mongoose.Schema.Types.ObjectId,
                ref:"Product"
            },
            name:{
                type:String,
                required:true
            },
            sellingPrice:{
                type:Number,
                required:true
            },
            costPrice:{
                type:Number,
                required:true
            },
            quantity:{
                type:Number,
                required:true
            },
            unit:{
                type:String,
                required:true
            }

        }
    ],
    totalAmount:{
        type:Number,
        required:true
    },
    subtotal:{
        type:Number,
        default:0
    },
    discountPercent:{
        type:Number,
        default:0
    },
    taxPercent:{
        type:Number,
        default:0
    },
    invoiceNumber: {
        type: String,
        unique: true,
        sparse: true
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    }
},{ timestamps: true })

// Pre-save hook to handle splitPaymentDetails validation
// Remove splitPaymentDetails if it's null, undefined, or if payment method is not split
OrderSchema.pre('save', function(next) {
    // If splitPaymentDetails is null, undefined, or payment method is not split, remove it
    if (this.splitPaymentDetails === null || 
        this.splitPaymentDetails === undefined || 
        this.paymentMethod !== 'split') {
        this.splitPaymentDetails = undefined;
    }
    // If splitPaymentDetails exists but type is null or undefined, remove the entire object
    else if (this.splitPaymentDetails && 
             (this.splitPaymentDetails.type === null || 
              this.splitPaymentDetails.type === undefined)) {
        this.splitPaymentDetails = undefined;
    }
    // If splitPaymentDetails exists but is an empty object, remove it
    else if (this.splitPaymentDetails && 
             typeof this.splitPaymentDetails === 'object' &&
             Object.keys(this.splitPaymentDetails).length === 0) {
        this.splitPaymentDetails = undefined;
    }
    next();
});


// Add index to prevent duplicate orders within short time window
// Index on sellerId, customerId, totalAmount, and createdAt for faster duplicate detection
OrderSchema.index({ sellerId: 1, customerId: 1, totalAmount: 1, createdAt: -1 });

module.exports = mongoose.model("Order",OrderSchema);