const mongoose = require("mongoose");
const CustomerSchema = new mongoose.Schema({
    sellerId:{
        type:mongoose.Schema.Types.ObjectId,
        required:true,
        ref:"Seller"
    },
    name:{
        type:String,
        required:true
    },
    dueAmount:{
        type:Number,
        default:0
    },
    mobileNumber:{
        type:String,
    },
    email:{
        type:String,
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    }
    
}, { timestamps: true });

module.exports = mongoose.model("Customer",CustomerSchema);