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
        enum:["cash","card","upi","due","credit"],
        required:true,
        default:"cash"
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
    }
},{ timestamps: true })

// Add index to prevent duplicate orders within short time window
// Index on sellerId, customerId, totalAmount, and createdAt for faster duplicate detection
OrderSchema.index({ sellerId: 1, customerId: 1, totalAmount: 1, createdAt: -1 });

module.exports = mongoose.model("Order",OrderSchema);